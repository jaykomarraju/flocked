// PIPE-1, WebSocket half (spec "API" › Reveal gating: no WebSocket message exposes per-option data
// for a mode until that mode's `revealed_at` is set). The real settlement pipelines are run to the
// dangerous window (test/gating/helpers.ts): the settlement record, the entries' outcomes and the
// bundle are durable while `revealed_at` is still null. In that window no `state` snapshot and no
// message carries per-option data; after the reveal the snapshot carries the result. For Stakes the
// round's RoundDO is live, so the confirmed proposal reaches viewers through the real indexer
// handler, and a finalized mode reads as final from D1 while the RoundDO stays `settle_proposed`.
import { env } from 'cloudflare:test';
import type { SettleMessage, WsServerMessage } from '@flocked/shared';
import { QUICKNET, beaconTime } from '@flocked/tlock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { viewerStub } from '../../src/ws/shards.js';
import { seedFixture } from '../helpers/index.js';
import {
  HOUR,
  freeToWindow,
  perOptionData,
  seedFree,
  seedStakesRound,
  stakesToWindow,
} from '../gating/helpers.js';
import { BEACON } from '../settlement/helpers.js';
import { setGameClock, stakesEnv } from '../settlement/stakes-helpers.js';
import {
  closeAll,
  connect,
  freshSnapshot,
  hubIdle,
  snapshot,
  stateOf,
  until,
  type Viewer,
} from './helpers.js';

const original = { QUEUE_SETTLE: env.QUEUE_SETTLE, QUEUE_NOTIFY: env.QUEUE_NOTIFY };

beforeAll(async () => {
  await seedFixture(env.DB);
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  Object.assign(env, original);
  vi.restoreAllMocks();
});

/** Every message the viewer got that carries per-option data. */
const leaks = (v: Viewer, upTo = v.messages.length) =>
  v.messages.slice(0, upTo).flatMap((m, i) => perOptionData(m, `$[${i}](${m.type})`));

describe('PIPE-1 (WebSocket): nothing per option before the mode’s revealed_at', () => {
  it('Free: nothing in the window (record, outcomes and bundle durable); the result after the reveal', async () => {
    const r = await seedFree([0, 1, 1]);
    const early = await connect(r.roundId);
    const w = await freeToWindow(r.roundId);

    const windowed = await freshSnapshot(r.roundId);
    expect(windowed.modes.free).toMatchObject({
      status: 'revealing',
      revealedAt: null,
      result: null,
    });
    expect(perOptionData(windowed)).toEqual([]);
    expect(leaks(early)).toEqual([]);

    await w.reveal();
    const after = await freshSnapshot(r.roundId);
    expect(after.modes.free).toMatchObject({
      status: 'settled',
      entrantCount: 3,
      pool: '30',
      result: { winningOption: 0, tally: [{ headcount: 1 }, { headcount: 2 }] },
    });
    expect(after.modes.free?.revealedAt).toEqual(expect.any(Number));
    expect(perOptionData(after)).not.toEqual([]);
    await closeAll([early]);
  });

  it('Stakes: nothing while the proposal is unconfirmed; `revealed` with claimsOpenAt once confirmed; final from D1', async () => {
    const r = await seedStakesRound([0, 0, 1]);
    const id = r.roundId;
    // The round's RoundDO, live from lock: its alarms close the round and start settlement.
    const settled: SettleMessage[] = [];
    Object.assign(env, {
      QUEUE_SETTLE: {
        send: (body: SettleMessage) => {
          settled.push(body);
          return Promise.resolve();
        },
      },
      QUEUE_NOTIFY: { send: () => Promise.resolve(), sendBatch: () => Promise.resolve() },
    });
    const stub = env.ROUND.get(env.ROUND.idFromName(id));
    const viewer = await connect(id);
    setGameClock(beaconTime(QUICKNET, BEACON.round) * 1000 + 5_000);
    await stub.init({
      roundId: id,
      kind: 'daily',
      roomId: null,
      questionId: id,
      opensAt: r.closesAt - 24 * HOUR,
      closesAt: r.closesAt,
      beaconRound: BEACON.round,
      beaconTimeSec: beaconTime(QUICKNET, BEACON.round),
      config: r.config,
      modes: ['stakes'],
      chainRoundId: r.chainRoundId.toString(),
    });
    await hubIdle(stub, id);
    await until(() => viewer.of('revealing').length === 1);
    expect(settled.map((s) => s.idempotencyKey)).toContain(`${id}:stakes`);
    Object.assign(env, original);

    // The window: record, outcomes and bundle hash in D1, `propose` mined, not yet indexed.
    const w = await stakesToWindow(r);
    const windowed = await snapshot(id);
    expect(windowed.modes.stakes).toMatchObject({
      status: 'revealing',
      revealedAt: null,
      claimsOpenAt: null,
      result: null,
      entrantCount: 3,
    });
    expect(perOptionData(windowed)).toEqual([]);
    expect(leaks(viewer)).toEqual([]);
    expect(viewer.messages.map((m) => m.type)).toEqual(['state', 'closed', 'revealing']);

    // Confirmed onchain: the indexer tells the RoundDO, which broadcasts `revealed`.
    const before = viewer.messages.length;
    await w.reveal();
    await hubIdle(stub, id);
    await until(() => viewer.of('revealed').length === 1);
    expect(leaks(viewer, before)).toEqual([]);
    const claimsOpenAt = r.chain.round(r.chainRoundId).claimsOpenAt * 1000;
    const revealed = viewer.of('revealed')[0];
    expect(revealed).toMatchObject({ mode: 'stakes', winningOption: 1, claimsOpenAt });
    const proposed = await snapshot(id);
    expect(proposed.modes.stakes).toMatchObject({
      status: 'settle_proposed',
      claimsOpenAt,
      result: { winningOption: 1, tally: revealed?.tally },
    });

    // Finalized onchain: D1 is the record (the RoundDO is never told and stays settle_proposed).
    await w.finalize();
    expect((await stub.getState()).modes.stakes?.status).toBe('settle_proposed');
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // a kept snapshot expires
    const final = await snapshot(id);
    expect(final.modes.stakes).toMatchObject({ status: 'settled', claimsOpenAt });
    expect(final.modes.stakes?.result?.winningOption).toBe(1);
    await closeAll([viewer]);
  });

  it('a relayed message never carries more than its wire shape (extra keys are dropped)', async () => {
    const r = await seedFree([0, 1]);
    const v = await connect(r.roundId);
    const smuggled = {
      type: 'counts',
      roundId: r.roundId,
      modes: { free: { entrantCount: 2, pool: '20', tally: [{ headcount: 1, total: '10' }] } },
      winningOption: 0,
    } as unknown as WsServerMessage;
    for (let shard = 0; shard < 16; shard++) {
      await viewerStub(env, r.roundId, shard).broadcast(smuggled);
    }
    await until(() => v.of('counts').length === 1);
    expect(v.of('counts')[0]).toEqual({
      type: 'counts',
      roundId: r.roundId,
      modes: { free: { entrantCount: 2, pool: '20' } },
    });
    // A `state` is never relayed (it is per connection), let alone one with a result before reveal.
    const forged = {
      ...stateOf(v),
      modes: {
        free: { ...stateOf(v).modes.free, result: { winningOption: 0, tally: [] } },
      },
    } as unknown as WsServerMessage;
    expect(await viewerStub(env, r.roundId, 0).broadcast(forged)).toEqual({ delivered: 0 });
    await closeAll([v]);
  });
});
