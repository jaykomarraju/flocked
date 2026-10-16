// Room points (spec "Profiles, leaderboards and rooms" › Room points): Free room rounds stake room
// points (`point_balances` scope = the room ID), never global ones; +100 per room round on the
// member's first visit or entry after the round opens, if the room balance is below 1,000 (ledger
// `room_grant`, ref = the room round), and a skip at ≥ 1,000 is final for that round. Here: the grant
// itself (src/rounds/grant.ts `applyRoomGrant`) and the entry-time grant in the RoundDO's commit
// protocol, ahead of the stake debit (W8-D).
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRoomGrant, dailyGrantEligible } from '../../src/rounds/grant.js';
import {
  BASE_OPENS_AT,
  HOUR,
  createRound,
  createUser,
  errCode,
  okValue,
  sealedPick,
  setClock,
  useTestSigner,
  type TestRound,
} from '../round-do/helpers.js';
import { balanceOf, insertRoom, insertUser, ledgerFor } from './round-helpers.js';

const OPEN_NOW = BASE_OPENS_AT + 12 * HOUR;

beforeAll(() => {
  useTestSigner();
});
beforeEach(() => setClock(OPEN_NOW));
afterEach(() => vi.restoreAllMocks());

let rounds = 0;
/** An open room round of `roomId`, initialised in its RoundDO (each one a day after the last). */
async function openRoomRound(roomId: string, opts: Parameters<typeof createRound>[0] = {}) {
  const opensAt = BASE_OPENS_AT + 24 * HOUR * rounds++;
  const r = await createRound({ roomId, opensAt, ...opts });
  setClock(opensAt + HOUR);
  await r.stub.init(r.locked);
  return r;
}

async function enter(r: TestRound, userId: string, stake = '25') {
  return r.stub.enterFree({
    roundId: r.locked.roundId,
    userId,
    body: { stake, ciphertext: await sealedPick(r.locked) },
  });
}

async function skipOf(userId: string, roundId: string) {
  return env.DB.prepare(
    'SELECT balance FROM daily_grant_skips WHERE user_id = ?1 AND round_id = ?2',
  )
    .bind(userId, roundId)
    .first<{ balance: number }>();
}

async function globalLedger(userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT reason, delta, ref_id FROM points_ledger WHERE user_id = ?1 AND scope = 'global' ORDER BY id",
  )
    .bind(userId)
    .all();
  return results;
}

describe('applyRoomGrant', () => {
  it('credits +100 room points once per (member, room round), below 1,000, with no farming rule', async () => {
    const { roomId } = await insertRoom({ source: 'custom' });
    // A brand-new account with no linked identity: not eligible for the daily grant.
    const u = await insertUser({ createdAt: OPEN_NOW });
    expect(await dailyGrantEligible(env.DB, { userId: u, now: OPEN_NOW })).toBe(false);
    const grant = (roundId: string) =>
      applyRoomGrant(env.DB, { userId: u, roomId, roundId, now: OPEN_NOW });

    expect(await grant('round-a')).toMatchObject({ status: 'applied' });
    expect(await balanceOf(u, roomId)).toBe(100); // the balance row is made on the way
    expect(await ledgerFor(u, roomId, 'round-a')).toEqual([{ reason: 'room_grant', delta: 100 }]);
    expect(await grant('round-a')).toMatchObject({ status: 'duplicate' });
    expect(await balanceOf(u, roomId)).toBe(100);
    // The next room round grants again; nothing ever lands in the global scope.
    expect(await grant('round-b')).toMatchObject({ status: 'applied' });
    expect(await balanceOf(u, roomId)).toBe(200);
    expect(await balanceOf(u, 'global')).toBeNull();
    expect(await globalLedger(u)).toEqual([]);
  });

  it('a skip at ≥ 1,000 is recorded and final for that round, even after the balance drops', async () => {
    const { roomId } = await insertRoom({ source: 'custom' });
    const u = await insertUser();
    await env.DB.prepare(
      'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, 1000, 0)',
    )
      .bind(u, roomId)
      .run();
    const grant = (roundId: string) =>
      applyRoomGrant(env.DB, { userId: u, roomId, roundId, now: OPEN_NOW });
    expect(await grant('round-c')).toEqual({ status: 'skipped' });
    expect(await skipOf(u, 'round-c')).toEqual({ balance: 1000 });
    await env.DB.prepare(
      'UPDATE point_balances SET balance = 900 WHERE user_id = ?1 AND scope = ?2',
    )
      .bind(u, roomId)
      .run();
    expect(await grant('round-c')).toEqual({ status: 'skipped' });
    expect(await ledgerFor(u, roomId, 'round-c')).toEqual([]);
    // Another round below 1,000 is granted.
    expect(await grant('round-d')).toMatchObject({ status: 'applied' });
    expect(await balanceOf(u, roomId)).toBe(1000);
  });
});

describe('the entry-time room grant (RoundDO)', () => {
  it('+100 on the member’s first entry, before the stake, once', async () => {
    const { roomId } = await insertRoom({ source: 'custom' });
    const r = await openRoomRound(roomId);
    const u = await createUser(500, roomId);
    okValue(await enter(r, u, '25'));
    expect(await balanceOf(u, roomId)).toBe(575);
    expect(await ledgerFor(u, roomId, r.locked.roundId)).toEqual([
      { reason: 'room_grant', delta: 100 },
      { reason: 'stake', delta: -25 },
    ]);
    // Once: a later (refused) entry and a visit's grant for the same round credit nothing more.
    expect(errCode(await enter(r, u, '50'))).toBe('already_entered');
    expect(
      await applyRoomGrant(env.DB, { userId: u, roomId, roundId: r.locked.roundId, now: OPEN_NOW }),
    ).toMatchObject({ status: 'duplicate' });
    expect(await balanceOf(u, roomId)).toBe(575);
  });

  it('a member at ≥ 1,000 gets no grant; the skip is recorded and final for that round', async () => {
    const { roomId } = await insertRoom({ source: 'custom' });
    const r = await openRoomRound(roomId);
    const u = await createUser(1000, roomId);
    okValue(await enter(r, u, '100'));
    expect(await balanceOf(u, roomId)).toBe(900);
    expect(await skipOf(u, r.locked.roundId)).toEqual({ balance: 1000 });
    // Now below 1,000, a visit the same round still gets nothing.
    expect(
      await applyRoomGrant(env.DB, { userId: u, roomId, roundId: r.locked.roundId, now: OPEN_NOW }),
    ).toEqual({ status: 'skipped' });
    expect(await ledgerFor(u, roomId, r.locked.roundId)).toEqual([
      { reason: 'stake', delta: -100 },
    ]);
    expect(await balanceOf(u, roomId)).toBe(900);

    // The room's next round, below 1,000: granted at entry.
    const next = await openRoomRound(roomId);
    okValue(await enter(next, u, '25'));
    expect(await ledgerFor(u, roomId, next.locked.roundId)).toEqual([
      { reason: 'room_grant', delta: 100 },
      { reason: 'stake', delta: -25 },
    ]);
    expect(await balanceOf(u, roomId)).toBe(975);
  });

  it('a room entry debits the room scope and never the global one', async () => {
    const { roomId } = await insertRoom({ source: 'custom' });
    const r = await openRoomRound(roomId, { free: { stakeMax: '500' } });
    const u = await createUser(500, roomId);
    await env.DB.prepare(
      "INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, 'global', 2000, 0)",
    )
      .bind(u)
      .run();
    okValue(await enter(r, u, '300'));
    expect(await balanceOf(u, roomId)).toBe(300); // 500 + 100 − 300
    expect(await balanceOf(u, 'global')).toBe(2000);
    expect(await globalLedger(u)).toEqual([]);

    // Global points never cover a room stake: a member short in the room is refused.
    const poor = await createUser(10, roomId);
    await env.DB.prepare(
      "INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, 'global', 2000, 0)",
    )
      .bind(poor)
      .run();
    expect(errCode(await enter(r, poor, '200'))).toBe('insufficient_balance');
    expect(await balanceOf(poor, roomId)).toBe(110); // 10 + the grant; no stake
    expect(await balanceOf(poor, 'global')).toBe(2000);
    expect(await globalLedger(poor)).toEqual([]);
  });

  it('a daily round pays no room grant', async () => {
    const r = await createRound({ kind: 'daily', opensAt: BASE_OPENS_AT });
    setClock(OPEN_NOW);
    await r.stub.init(r.locked);
    const u = await createUser(500);
    okValue(await enter(r, u, '25'));
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ?1 AND reason = 'room_grant'",
    )
      .bind(u)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
    expect(await balanceOf(u, 'global')).toBe(475);
  });
});
