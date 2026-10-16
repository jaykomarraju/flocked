// W7-F1 review fixes in the viewer shards' `state` and catch-up (src/ws/snapshot.ts,
// src/do/round-viewer-do.ts; spec "Real-time and the reveal"):
//   - R1: past beacon time a closed round's mode that D1 still shows `pending` reads `revealing`, so
//     a viewer arriving after the 30 s replay window (a late beacon, slow relays, a shard that
//     slept) is not left at `pending`, and a reconnect never goes backwards;
//   - R4: the catch-up after `state` sends only each mode's newest event: a `revealed` older than a
//     `refunded` the state already shows is never replayed.
import { env } from 'cloudflare:test';
import type { WsServerMessage, WsStateMessage } from '@flocked/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { viewerStub } from '../../src/ws/shards.js';
import { BASE_OPENS_AT, HOUR, createRound, setClock } from '../round-do/helpers.js';
import { closeAll, connect, freshSnapshot } from './helpers.js';

type OptionTally = { headcount: number; total: string };

const OPENS_AT = BASE_OPENS_AT + 80 * 24 * HOUR;
const TALLY: [OptionTally, OptionTally] = [
  { headcount: 1, total: '5000000' },
  { headcount: 2, total: '10000000' },
];

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

const statuses = (s: WsStateMessage) => ({
  free: s.modes.free?.status,
  stakes: s.modes.stakes?.status,
});

/** Relays `messages` to every shard of the round, as the RoundDO's hub does. */
async function relay(roundId: string, messages: WsServerMessage[]): Promise<void> {
  for (const m of messages) {
    for (let shard = 0; shard < 16; shard++) await viewerStub(env, roundId, shard).broadcast(m);
  }
}

/** Connects; returns every message that arrived in the first 200 ms (state and its catch-up). */
async function arrivals(roundId: string): Promise<WsServerMessage[]> {
  const v = await connect(roundId);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await closeAll([v]);
  return v.messages;
}

describe('R1: past beacon time a closed round never shows pending', () => {
  it('a viewer arriving after the replay window gets revealing in its state; reflected, not replayed', async () => {
    const r = await createRound({ kind: 'daily', opensAt: OPENS_AT, modes: ['free', 'stakes'] });
    const id = r.locked.roundId;
    const beaconMs = r.locked.beaconTimeSec * 1000;
    // Closed in D1; the modes are still pending there (nothing has moved them yet).
    await env.DB.prepare("UPDATE rounds SET status = 'closed' WHERE id = ?1").bind(id).run();

    // Before beacon time: pending.
    setClock(beaconMs - 1_000);
    expect(statuses(await freshSnapshot(id))).toEqual({ free: 'pending', stakes: 'pending' });

    // 31 s past beacon time with no `revealing` relayed to this shard (a late beacon alarm, or a
    // shard that slept and lost its replay buffer): the state says revealing all the same.
    setClock(beaconMs + 31_000);
    const late = await freshSnapshot(id);
    expect(statuses(late)).toEqual({ free: 'revealing', stakes: 'revealing' });
    expect(late.modes.free).toMatchObject({ revealedAt: null, result: null });

    // The RoundDO's `revealing` arrives now: a new viewer gets the state alone, since it shows it.
    await relay(id, [
      { type: 'revealing', roundId: id, mode: 'free' },
      { type: 'revealing', roundId: id, mode: 'stakes' },
    ]);
    const messages = await arrivals(id);
    expect(messages.map((m) => m.type)).toEqual(['state']);
    expect(statuses(messages[0] as WsStateMessage)).toEqual({
      free: 'revealing',
      stakes: 'revealing',
    });
  });
});

describe('R4: the catch-up never replays an event older than a newer one for its mode', () => {
  it('a revealed relayed before a refunded is not replayed after a state that shows the refund', async () => {
    setClock(OPENS_AT + 3 * 24 * HOUR);
    const r = await createRound({
      kind: 'daily',
      opensAt: OPENS_AT + 3 * 24 * HOUR - HOUR,
      modes: ['stakes'],
    });
    const id = r.locked.roundId;
    await r.stub.init(r.locked);
    const claimsOpenAt = r.locked.closesAt + 2 * HOUR;
    const revealed: WsServerMessage = {
      type: 'revealed',
      roundId: id,
      mode: 'stakes',
      winningOption: 1,
      tally: TALLY,
      claimsOpenAt,
    };
    const refunded: WsServerMessage = {
      type: 'refunded',
      roundId: id,
      mode: 'stakes',
      refundReason: 5,
      provisional: true,
      finalAt: claimsOpenAt + HOUR,
    };
    // The proposal was vetoed and a refund proposed; D1 already shows the refund proposal.
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'refund_proposed', refund_reason = 5, claims_open_at = ?2 WHERE round_id = ?1",
    )
      .bind(id, claimsOpenAt + HOUR)
      .run();
    await relay(id, [revealed, refunded]);
    const messages = await arrivals(id);
    expect(messages.map((m) => m.type)).toEqual(['state']);
    expect((messages[0] as WsStateMessage).modes.stakes).toMatchObject({
      status: 'refund_proposed',
      refundReason: 5,
      result: null,
    });

    // Neither shown yet (D1 lags both): only the newest follows the state.
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'revealing', refund_reason = NULL, claims_open_at = NULL WHERE round_id = ?1",
    )
      .bind(id)
      .run();
    await relay(id, [revealed, refunded]);
    expect(await arrivals(id)).toEqual([expect.objectContaining({ type: 'state' }), refunded]);
  });
});
