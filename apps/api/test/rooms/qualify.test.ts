// The room minimum (spec "Profiles, leaderboards and rooms" › Rooms, Anti-farming; "Settlement and
// payout math" rule 1): a room round refunds unless it has at least 3 qualifying entrants, valid
// entries from distinct users whose accounts were at least 24 hours old at `closesAt`. The API decides
// which entries qualify (src/settlement/reduce.ts) and settlement counts only those for rule 1
// (`countQualifyingOnly`, against the locked minEntrants 3). Every room round here goes through the
// real pipeline: SettlementDO, the decrypt consumer, reduce, the bundle in R2 and the real applyFree.
import { env } from 'cloudflare:test';
import { ROOM_QUALIFYING_ACCOUNT_AGE_MS, type Mode } from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleParams } from '../../src/settlement/reduce.js';
import type { SettlementRound } from '../../src/settlement/prepare.js';
import { atBeaconPlus, harness, seedPicks } from '../settlement/helpers.js';
import {
  addMember,
  balanceOf,
  bundleChunk,
  freeMode,
  insertRoom,
  insertUser,
  ledgerFor,
  roomFreeConfig,
  seedRoomFree,
  setCreatedAt,
  type RoomEntrant,
  type SeededRoomRound,
} from './round-helpers.js';

afterEach(() => vi.restoreAllMocks());

type Age = 'old' | 'young' | 'none';

/**
 * A room whose members enter with `picks`, their accounts aged per `ages` at the round's closesAt:
 * `old` exactly 24 h before it (the boundary qualifies), `young` 1 ms later, `none` no users row.
 */
async function roomRound(
  picks: RoomEntrant['pick'][],
  ages: Age[],
): Promise<{ r: SeededRoomRound; roomId: string; users: string[] }> {
  const { roomId } = await insertRoom({ source: 'custom' });
  const users: string[] = [];
  for (const age of ages) {
    const id = await insertUser();
    await addMember(roomId, id, 500);
    users.push(id);
    if (age === 'none') await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id).run();
  }
  const r = await seedRoomFree(
    roomId,
    picks.map((pick, i) => ({ userId: users[i] as string, pick })),
  );
  const cutoff = r.closesAt - ROOM_QUALIFYING_ACCOUNT_AGE_MS;
  for (const [i, age] of ages.entries()) {
    if (age !== 'none') await setCreatedAt(users[i] as string, age === 'old' ? cutoff : cutoff + 1);
  }
  return { r, roomId, users };
}

/** Runs the real pipeline (the real applyFree unless `record`, which only records the result). */
async function settle(roundId: string, apply: 'real' | 'record' = 'real') {
  atBeaconPlus(5_000);
  const h = await harness(roundId, { apply });
  expect(await h.run()).toMatchObject({ phase: 'done', error: null });
  const result = h.applied[0];
  if (!result) throw new Error('nothing applied');
  return result;
}

async function payoutsOf(roundId: string) {
  const { results } = await env.DB.prepare(
    'SELECT user_id, kind, amount FROM payouts WHERE round_id = ?1 ORDER BY amount, user_id',
  )
    .bind(roundId)
    .all<{ user_id: string; kind: string; amount: number }>();
  return results;
}

describe('room minimum refund (rule 1 counts qualifying entrants only)', () => {
  it('3 valid entries, one account under 24 h old at closesAt: refunded under rule 1, in the room scope', async () => {
    const { r, roomId, users } = await roomRound([0, 1, 1], ['old', 'old', 'young']);
    const result = await settle(r.roundId);
    expect(result.record).toMatchObject({ outcome: 'refunded', refundReason: 1, n: [1n, 2n] });
    expect(await freeMode(r.roundId)).toEqual({ status: 'refunded', refund_reason: 1 });
    for (const u of users) {
      expect(await ledgerFor(u, roomId, r.roundId)).toEqual([{ reason: 'refund', delta: 10 }]);
      expect(await balanceOf(u, roomId)).toBe(510); // the seeded entry took no stake
      expect(await balanceOf(u, 'global')).toBeNull();
    }
    expect((await payoutsOf(r.roundId)).map((p) => [p.kind, p.amount])).toEqual([
      ['refund', 10],
      ['refund', 10],
      ['refund', 10],
    ]);
  });

  it('the same round with three accounts old enough settles', async () => {
    const { r, roomId, users } = await roomRound([0, 1, 1], ['old', 'old', 'old']);
    const result = await settle(r.roundId);
    expect(result.record).toMatchObject({ outcome: 'settled', refundReason: null, winner: 0 });
    expect(await freeMode(r.roundId)).toEqual({ status: 'settled', refund_reason: null });
    // The Stray (option 0) wins the losers' 20 in room points; nothing moves globally.
    expect(await ledgerFor(users[0] as string, roomId, r.roundId)).toEqual([
      { reason: 'payout', delta: 30 },
    ]);
    for (const u of users) expect(await balanceOf(u, 'global')).toBeNull();
  });

  it('a VOID entry does not qualify: with one young account, an old VOID does not make up the count', async () => {
    const { r } = await roomRound([0, 1, 1, 'void'], ['old', 'old', 'young', 'old']);
    const result = await settle(r.roundId);
    expect(result.record).toMatchObject({ outcome: 'refunded', refundReason: 1, voidCount: 1n });
    expect(result.entries.map((e) => e.qualifies)).toEqual([true, true, false, false]);
  });

  it('three qualifying entrants settle beside a VOID; an entry with no users row never qualifies', async () => {
    const settled = await roomRound([0, 1, 1, 'void'], ['old', 'old', 'old', 'old']);
    expect((await settle(settled.r.roundId)).record.outcome).toBe('settled');
    const missing = await roomRound([0, 1, 1], ['old', 'old', 'none']);
    const result = await settle(missing.r.roundId);
    expect(result.record).toMatchObject({ outcome: 'refunded', refundReason: 1 });
    expect(result.entries.map((e) => e.qualifies)).toEqual([true, true, false]);
  });

  it('the bundle’s room chunk carries `qualifies` per entry; a daily round’s carries none', async () => {
    const { r } = await roomRound([0, 1, 1, 'void'], ['old', 'young', 'old', 'old']);
    await settle(r.roundId);
    const chunk = await bundleChunk(r.roundId);
    expect(chunk.entries.map((e) => [e.seq, e.valid, e.qualifies])).toEqual([
      [0, true, true],
      [1, true, false],
      [2, true, true],
      [3, false, false],
    ]);
    const manifest = await env.BUCKET.get(`bundles/${r.roundId}/free/manifest.json`);
    expect(await manifest?.json()).toMatchObject({ kind: 'room', entryCount: 4 });

    const daily = await seedPicks([0, 1, 1]);
    await settle(daily.roundId, 'record'); // reduce writes the bundle; nothing to apply here
    const dailyChunk = await bundleChunk(daily.roundId);
    expect(dailyChunk.entries).toHaveLength(3);
    for (const e of dailyChunk.entries) expect('qualifies' in e).toBe(false);
  });
});

describe('settleParams', () => {
  const round = (kind: 'daily' | 'room', mode: Mode = 'free'): SettlementRound =>
    ({ kind, mode, config: roomFreeConfig() }) as unknown as SettlementRound;

  it('counts only qualifying entries for a room round, all valid entries for a daily round', () => {
    expect(settleParams(round('room'))).toMatchObject({
      minEntrants: 3,
      countQualifyingOnly: true,
    });
    expect(settleParams(round('daily'))).not.toHaveProperty('countQualifyingOnly');
  });
});
