// Coalescing (spec "Real-time and the reveal": broadcast counter updates at most once per second,
// coalesced): a burst or a steady stream of entries reaches each socket as at most one `counts` per
// second, and the last `counts` is the current total. Entries are real: Free through enterFree,
// Stakes through ingestStakesEntry (the indexer's path).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COUNTS_INTERVAL_MS, type FanoutResult } from '../../src/ws/hub.js';
import {
  BASE_OPENS_AT,
  HOUR,
  createRound,
  createUser,
  okValue,
  sealedPick,
  setClock,
  useTestSigner,
  type TestRound,
} from '../round-do/helpers.js';
import { closeAll, connect, enteredEvent, hubIdle, until, type Viewer } from './helpers.js';

const OPENS_AT = BASE_OPENS_AT + 60 * 24 * HOUR;
/** Timer slack on the hub's own clock. Arrival gaps aren't checked: delivery jitter shrinks them. */
const TIMER_SLACK_MS = 10;

let r: TestRound;
let viewers: Viewer[];

beforeAll(async () => {
  useTestSigner();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setClock(OPENS_AT + HOUR);
  r = await createRound({ kind: 'daily', opensAt: OPENS_AT, modes: ['free', 'stakes'] });
  await r.stub.init(r.locked);
  viewers = await Promise.all([1, 2, 3].map(() => connect(r.locked.roundId)));
});
afterAll(async () => {
  await closeAll(viewers);
  vi.restoreAllMocks();
});

async function enterFree(): Promise<void> {
  const userId = await createUser(1000);
  const ciphertext = await sealedPick(r.locked);
  okValue(
    await r.stub.enterFree({
      roundId: r.locked.roundId,
      userId,
      body: { stake: '10', ciphertext },
    }),
  );
}

const enterStakes = () => r.stub.ingestStakesEntry(enteredEvent(r.locked.roundId));

/** Each viewer's `counts` from index `from` on: arrival times and the messages. */
function countsSince(v: Viewer, from: number) {
  const out: { at: number; free: number; stakes: number }[] = [];
  for (let i = from; i < v.messages.length; i++) {
    const m = v.messages[i];
    if (m?.type !== 'counts') continue;
    out.push({
      at: v.times[i] as number,
      free: m.modes.free?.entrantCount ?? -1,
      stakes: m.modes.stakes?.entrantCount ?? -1,
    });
  }
  return out;
}

function expectAtMostOnePerSecond(
  counts: { at: number }[],
  spanMs: number,
  sent: FanoutResult[],
): void {
  // Leading edge, then at most one per elapsed second, then the trailing one.
  expect(counts.length).toBeLessThanOrEqual(Math.ceil(spanMs / COUNTS_INTERVAL_MS) + 1);
  // The spacing is the hub's: it releases one `counts` per interval (W7-Z: arrival times flaked).
  const released = sent.filter((f) => f.type === 'counts').map((f) => f.releasedAt);
  expect(released.length).toBe(counts.length);
  for (let i = 1; i < released.length; i++) {
    const gap = (released[i] as number) - (released[i - 1] as number);
    expect(gap).toBeGreaterThanOrEqual(COUNTS_INTERVAL_MS - TIMER_SLACK_MS);
  }
}

describe('counts: at most one per second per socket, the last one current', () => {
  it('a burst of entries arrives as a leading and a trailing counts', async () => {
    const marks = viewers.map((v) => v.messages.length);
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await enterFree();
    for (let i = 0; i < 8; i++) await enterStakes();
    const span = Date.now() - t0;
    const sent = await hubIdle(r.stub, r.locked.roundId);
    expect(sent.every((f) => f.type === 'counts' && f.failedShards === 0)).toBe(true);
    for (const [i, v] of viewers.entries()) {
      await until(() => countsSince(v, marks[i] as number).at(-1)?.stakes === 8);
      const counts = countsSince(v, marks[i] as number);
      expect(counts.at(-1)).toMatchObject({ free: 4, stakes: 8 });
      expectAtMostOnePerSecond(counts, span, sent);
      // Twelve entries, far fewer messages.
      expect(counts.length).toBeLessThanOrEqual(span < COUNTS_INTERVAL_MS ? 2 : 3);
    }
  });

  it('a steady stream for about 2.5 s: one counts a second, and the final total arrives', async () => {
    // Past the previous trailing send, so this stream starts on a leading edge.
    await new Promise((resolve) => setTimeout(resolve, COUNTS_INTERVAL_MS));
    await hubIdle(r.stub, r.locked.roundId);
    const marks = viewers.map((v) => v.messages.length);
    const t0 = Date.now();
    for (let i = 0; i < 16; i++) {
      await enterStakes();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const span = Date.now() - t0;
    const sent = await hubIdle(r.stub, r.locked.roundId);
    for (const [i, v] of viewers.entries()) {
      await until(() => countsSince(v, marks[i] as number).at(-1)?.stakes === 24);
      const counts = countsSince(v, marks[i] as number);
      expectAtMostOnePerSecond(counts, span, sent);
      expect(counts.length).toBeGreaterThanOrEqual(2);
      expect(counts.at(-1)).toMatchObject({ free: 4, stakes: 24 });
    }
    // Every socket saw the same sequence.
    const seen = viewers.map((v, i) => countsSince(v, marks[i] as number).map((c) => c.stakes));
    expect(new Set(seen.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  it('a reconnect right after a burst gets the current counts in its state', async () => {
    for (let i = 0; i < 3; i++) await enterStakes();
    await hubIdle(r.stub, r.locked.roundId);
    const v = await connect(r.locked.roundId);
    expect(v.messages[0]).toMatchObject({
      type: 'state',
      modes: { free: { entrantCount: 4, pool: '40' }, stakes: { entrantCount: 27 } },
    });
    await closeAll([v]);
  });
});
