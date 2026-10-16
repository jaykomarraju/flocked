// W7-F1 R5: the hub's fan-out chain (src/ws/hub.ts) can't be stalled by one shard. Each shard call
// has a timeout (lowered here through the test-only hook), and a step that throws is logged and the
// chain goes on: in both cases the round's next message still reaches every viewer, in order.
import { env, runInDurableObject } from 'cloudflare:test';
import type { WsServerMessage } from '@flocked/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoundViewerDO } from '../../src/do/round-viewer-do.js';
import { publish, setShardRpcTimeoutForTests } from '../../src/ws/hub.js';
import { BASE_OPENS_AT, HOUR, createRound, setClock, type TestRound } from '../round-do/helpers.js';
import { closeAll, connect, hubIdle, until, type Viewer } from './helpers.js';

const OPENS_AT = BASE_OPENS_AT + 90 * 24 * HOUR;
/** The shortened per-shard timeout, and how long the hung shard call takes. */
const TIMEOUT_MS = 200;
const HANG_MS = 4_000;

const broadcast = Object.getOwnPropertyDescriptor(RoundViewerDO.prototype, 'broadcast');
const roundViewer = env.ROUND_VIEWER;

let r: TestRound;
let id: string;
let viewers: Viewer[];

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setClock(OPENS_AT + HOUR);
  r = await createRound({ kind: 'daily', opensAt: OPENS_AT, modes: ['free'] });
  id = r.locked.roundId;
  await r.stub.init(r.locked);
  viewers = await Promise.all([1, 2, 3, 4].map(() => connect(id)));
});
afterEach(() => {
  setShardRpcTimeoutForTests();
  if (broadcast) Object.defineProperty(RoundViewerDO.prototype, 'broadcast', broadcast);
  Object.assign(env, { ROUND_VIEWER: roundViewer });
});
afterAll(async () => {
  await closeAll(viewers);
  vi.restoreAllMocks();
});

/** Hands `messages` to the round's hub inside its RoundDO, as `broadcast()` does. */
async function send(...messages: WsServerMessage[]): Promise<void> {
  await runInDurableObject(r.stub, () => {
    for (const m of messages) publish(env, id, m);
  });
}

const typesAfterState = (v: Viewer) => v.messages.slice(1).map((m) => m.type);

describe('R5: one shard cannot stall the round’s later messages', () => {
  it('a shard whose broadcast hangs times out; the next message still goes out at once', async () => {
    setShardRpcTimeoutForTests(TIMEOUT_MS);
    const hang = { started: false, done: false };
    const original = broadcast?.value as (
      this: RoundViewerDO,
      m: WsServerMessage,
    ) => Promise<{ delivered: number }>;
    Object.defineProperty(RoundViewerDO.prototype, 'broadcast', {
      configurable: true,
      writable: true,
      value(this: RoundViewerDO, m: WsServerMessage) {
        // The first shard to get `revealing` never answers in time (and then reaches no one).
        if (m.type === 'revealing' && !hang.started) {
          hang.started = true;
          return new Promise((resolve) =>
            setTimeout(() => {
              hang.done = true;
              resolve({ delivered: 0 });
            }, HANG_MS),
          );
        }
        return original.call(this, m);
      },
    });
    const before = viewers.map((v) => v.messages.length);
    const sentAt = Date.now();
    await send(
      { type: 'revealing', roundId: id, mode: 'free' },
      {
        type: 'refunded',
        roundId: id,
        mode: 'free',
        refundReason: 7,
        provisional: false,
        finalAt: OPENS_AT + HOUR,
      },
    );
    // Well before the hung call would answer, every viewer has both, in order.
    for (const v of viewers) await until(() => v.of('refunded').length === 1, HANG_MS / 2);
    expect(Date.now() - sentAt).toBeLessThan(HANG_MS);
    viewers.forEach((v, i) => {
      expect(v.messages.slice(before[i]).map((m) => m.type)).toEqual(['revealing', 'refunded']);
    });
    // The hung shard was retried once (events get two tries), so nothing was lost.
    expect(await hubIdle(r.stub, id)).toMatchObject([
      { type: 'revealing', failedShards: 0 },
      { type: 'refunded', failedShards: 0 },
    ]);
    expect(hang.started).toBe(true);
    await until(() => hang.done, HANG_MS + 2_000);
  });

  it('a step of the chain that throws loses that message only; the next one goes out', async () => {
    let throwOnce = true;
    const before = viewers.map((v) => v.of('revealing').length);
    // The test pool checks the DO bindings on its first runInDurableObject: let it see the real one.
    await hubIdle(r.stub, id);
    Object.assign(env, {
      ROUND_VIEWER: {
        idFromName: (name: string) => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error('binding failed');
          }
          return roundViewer.idFromName(name);
        },
        get: (doId: DurableObjectId) => roundViewer.get(doId),
      },
    });
    await send(
      {
        type: 'closed',
        roundId: id,
        closesAt: r.locked.closesAt / 1000,
        beaconRound: r.locked.beaconRound,
        beaconTime: r.locked.beaconTimeSec,
      },
      { type: 'revealing', roundId: id, mode: 'free' },
    );
    for (const [i, v] of viewers.entries()) {
      await until(() => v.of('revealing').length === (before[i] ?? 0) + 1);
    }
    for (const v of viewers) {
      expect(v.of('closed')).toHaveLength(0);
      expect(typesAfterState(v).slice(-1)).toEqual(['revealing']);
    }
    expect(await hubIdle(r.stub, id)).toMatchObject([{ type: 'revealing', failedShards: 0 }]);
  });
});
