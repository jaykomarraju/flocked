// Shard fan-out (spec "Non-functional requirements" › Scaling notes: viewers sharded over N = 16
// RoundViewerDO instances): 256 sockets through the real upgrade route land on all 16 shards by
// hash(connection ID) mod 16, and every message the RoundDO hands to `broadcast()` reaches every
// socket exactly once, in order. Also: `refunded` carries `provisional` and `finalAt`, socket state
// lives in the hibernation attachment, and a closed socket is no longer counted.
import { env, runInDurableObject } from 'cloudflare:test';
import type { WsServerMessage } from '@flocked/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VIEWER_SHARDS,
  shardOf,
  viewerShardCount,
  viewerStub,
} from '../../src/ws/shards.js';
import { BASE_OPENS_AT, HOUR, createRound, setClock, type TestRound } from '../round-do/helpers.js';
import { closeAll, connect, enteredEvent, hubIdle, until, type Viewer } from './helpers.js';

const OPENS_AT = BASE_OPENS_AT + 70 * 24 * HOUR;
const NOW = OPENS_AT + HOUR;
const SOCKETS = 256;
const SHARDS = 16;

let r: TestRound;
let id: string;
let viewers: Viewer[];

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setClock(NOW);
  r = await createRound({ kind: 'daily', opensAt: OPENS_AT, modes: ['free', 'stakes'] });
  id = r.locked.roundId;
  await r.stub.init(r.locked);
  viewers = [];
  for (let i = 0; i < SOCKETS; i += 32) {
    viewers.push(...(await Promise.all(Array.from({ length: 32 }, () => connect(id)))));
  }
});
afterAll(async () => {
  await closeAll(viewers);
  vi.restoreAllMocks();
});

const openSockets = (shard: number) =>
  runInDurableObject(viewerStub(env, id, shard), (_i, state) =>
    state.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN),
  );

describe('16 shards, 256 sockets', () => {
  it('N defaults to 16; WS_VIEWER_SHARDS sets it (1 to 256), anything else falls back to 16', () => {
    expect(viewerShardCount(env)).toBe(DEFAULT_VIEWER_SHARDS);
    expect(DEFAULT_VIEWER_SHARDS).toBe(SHARDS);
    const withVar = (v: string) => viewerShardCount({ ...env, WS_VIEWER_SHARDS: v });
    expect(withVar('4')).toBe(4);
    expect(withVar('256')).toBe(256);
    for (const bad of ['0', '257', '-1', '2.5', 'many']) expect(withVar(bad)).toBe(16);
  });

  it('every shard holds sockets, each where hash(connection ID) mod 16 puts it', async () => {
    let total = 0;
    for (let shard = 0; shard < SHARDS; shard++) {
      const sockets = await runInDurableObject(viewerStub(env, id, shard), (_i, state) =>
        state.getWebSockets().map((ws) => ws.deserializeAttachment() as Record<string, unknown>),
      );
      expect(sockets.length).toBeGreaterThan(0);
      for (const a of sockets) {
        expect(a).toMatchObject({ shard, membersOnly: false });
        expect(shardOf(a.connId as string, SHARDS)).toBe(shard);
      }
      total += sockets.length;
    }
    expect(total).toBe(SOCKETS);
  });

  it('every RoundDO message reaches every socket once, in order', async () => {
    const claimsOpenAt = r.locked.closesAt + 2 * HOUR;
    await r.stub.ingestStakesEntry(enteredEvent(id));
    await r.stub.onModeResult('stakes', {
      outcome: 'refunded',
      reason: 1,
      provisional: true,
      claimsOpenAt,
    });
    await r.stub.onModeResult('free', { outcome: 'refunded', reason: 7, provisional: false });
    const sent = await hubIdle(r.stub, id);
    expect(sent).toMatchObject([
      { type: 'counts', delivered: SOCKETS, failedShards: 0 },
      { type: 'refunded', delivered: SOCKETS, failedShards: 0 },
      { type: 'refunded', delivered: SOCKETS, failedShards: 0 },
    ]);
    const expected: WsServerMessage[] = [
      {
        type: 'counts',
        roundId: id,
        modes: {
          free: { entrantCount: 0, pool: '0' },
          stakes: { entrantCount: 1, pool: '5000000' },
        },
      },
      // A Stakes refund proposal: provisional, final at the proposal's claimsOpenAt.
      {
        type: 'refunded',
        roundId: id,
        mode: 'stakes',
        refundReason: 1,
        provisional: true,
        finalAt: claimsOpenAt,
      },
      // A Free refund is final when the RoundDO learns of it (the game clock here).
      {
        type: 'refunded',
        roundId: id,
        mode: 'free',
        refundReason: 7,
        provisional: false,
        finalAt: NOW,
      },
    ];
    for (const v of viewers) {
      await until(() => v.messages.length === 1 + expected.length);
      expect(v.messages.slice(1)).toEqual(expected);
    }
  });

  it('a closed socket is no longer counted, and the rest still get each message once', async () => {
    const leaving = viewers.slice(0, 16);
    for (const v of leaving) v.ws.close(1000, 'bye');
    await vi.waitFor(
      async () => {
        let open = 0;
        for (let shard = 0; shard < SHARDS; shard++) open += (await openSockets(shard)).length;
        expect(open).toBe(SOCKETS - leaving.length);
      },
      { timeout: 5_000, interval: 50 },
    );
    await r.stub.ingestStakesEntry(enteredEvent(id));
    const sent = await hubIdle(r.stub, id);
    expect(sent).toMatchObject([
      { type: 'counts', delivered: SOCKETS - leaving.length, failedShards: 0 },
    ]);
    for (const v of viewers.slice(leaving.length)) {
      await until(() => v.messages.length === 5);
      expect(v.messages[4]).toMatchObject({
        type: 'counts',
        modes: { stakes: { entrantCount: 2 } },
      });
    }
    for (const v of leaving) expect(v.messages).toHaveLength(4);
  });
});
