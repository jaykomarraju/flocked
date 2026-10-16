// "Room rounds never count toward global stats, streaks, leaderboards or referrals" (spec "Profiles,
// leaderboards and rooms" › Rooms, Anti-farming). A room round settles through the real pipeline and
// the real applyFree, which runs the post-final hooks (`runModeFinal`) with kind `room`: every
// global table those hooks write stays as it was, room points move in the room scope only, and no
// board lists the room's entrants. A daily round settled the same way, with the same kind of
// entrants, writes all of them: the hooks did run.
import { env } from 'cloudflare:test';
import {
  LeaderboardResponseSchema,
  ROOM_QUALIFYING_ACCOUNT_AGE_MS,
  gameDayOf,
  isoWeekOf,
} from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boards } from '../../src/routes/boards.js';
import { withSession } from '../helpers/index.js';
import { atBeaconPlus, harness } from '../settlement/helpers.js';
import {
  addMember,
  balanceOf,
  freeMode,
  insertRoom,
  insertUser,
  ledgerFor,
  seedDailyFree,
  seedRoomFree,
  setCreatedAt,
  type SeededRoomRound,
} from './round-helpers.js';

afterEach(() => vi.restoreAllMocks());

/** Every global row the post-final hooks and global points could touch. */
async function globalState() {
  const all = (sql: string) =>
    env.DB.prepare(sql)
      .all()
      .then((r) => r.results);
  return {
    userStats: await all('SELECT * FROM user_stats ORDER BY user_id, mode'),
    statsDays: await all('SELECT * FROM stats_days ORDER BY round_id, mode'),
    statsWins: await all('SELECT * FROM stats_wins ORDER BY round_id, mode, user_id'),
    statsWeeks: await all('SELECT * FROM stats_weeks ORDER BY user_id, mode, iso_week'),
    referrals: await all('SELECT * FROM referrals ORDER BY referee_user_id'),
    splits: await all('SELECT * FROM question_splits ORDER BY round_id, mode'),
    balances: await all(
      "SELECT user_id, balance FROM point_balances WHERE scope = 'global' ORDER BY user_id",
    ),
    ledger: await all("SELECT * FROM points_ledger WHERE scope = 'global' ORDER BY id"),
  };
}

/** The user IDs every board lists for the round's game day and week (Free). */
async function listed(r: SeededRoomRound): Promise<Set<string>> {
  const closes = Math.floor(r.closesAt / 1000);
  const ids = new Set<string>();
  for (const path of [
    `/leaderboards/strays?period=${gameDayOf(closes)}&mode=free`,
    '/leaderboards/streaks?mode=free',
    `/leaderboards/weekly?period=${isoWeekOf(gameDayOf(closes))}&mode=free`,
    '/leaderboards/creators?mode=free',
  ]) {
    const res = await withSession(boards).request(path, {}, env);
    expect(res.status, path).toBe(200);
    for (const row of LeaderboardResponseSchema.parse(await res.json()).rows) ids.add(row.user.id);
  }
  return ids;
}

/** Two Strays on option 0, three on option 1. */
const PICKS = [0, 1, 1, 0, 1] as const;

async function settle(roundId: string): Promise<void> {
  atBeaconPlus(5_000);
  const h = await harness(roundId, { apply: 'real' });
  expect(await h.run()).toMatchObject({ phase: 'done', error: null });
}

/**
 * Five verified accounts (one per pick), old enough for the room minimum, each with 1,000 global
 * points; the last one (`referee`) has a pending referral from `referrer`. `author` writes the
 * round's question.
 */
async function entrants() {
  const users: string[] = [];
  for (let i = 0; i < PICKS.length; i++) users.push(await insertUser({ verified: true }));
  const referrer = await insertUser({ verified: true });
  const author = await insertUser({ verified: true });
  const referee = users[users.length - 1] as string;
  await env.DB.batch([
    ...users.map((u) =>
      env.DB.prepare(
        "INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, 'global', 1000, 0)",
      ).bind(u),
    ),
    env.DB.prepare(
      "INSERT INTO referrals (referrer_user_id, referee_user_id, status, created_at) VALUES (?1, ?2, 'pending', 0)",
    ).bind(referrer, referee),
  ]);
  return { users, referrer, referee, author };
}

describe('room rounds never touch global stats', () => {
  it('a settled room round changes no stats, streak, board, referral, split or global balance', async () => {
    const e = await entrants();
    const { roomId } = await insertRoom({ source: 'custom', owner: e.author });
    for (const u of e.users) await addMember(roomId, u, 500);
    const r = await seedRoomFree(
      roomId,
      e.users.map((userId, i) => ({ userId, pick: PICKS[i] as 0 | 1 })),
      { author: e.author },
    );
    for (const u of e.users) await setCreatedAt(u, r.closesAt - ROOM_QUALIFYING_ACCOUNT_AGE_MS);

    const before = await globalState();
    await settle(r.roundId);
    expect(await freeMode(r.roundId)).toEqual({ status: 'settled', refund_reason: null });
    // Room points moved, in the room scope (the Strays on option 0 won).
    expect(await ledgerFor(e.users[0] as string, roomId, r.roundId)).toEqual([
      { reason: 'payout', delta: 25 },
    ]);
    expect(await balanceOf(e.users[0] as string, roomId)).toBe(525);

    expect(await globalState()).toEqual(before);
    expect(before.referrals).toEqual([expect.objectContaining({ status: 'pending' })]);
    const onBoards = await listed(r);
    for (const u of [...e.users, e.author]) expect(onBoards.has(u)).toBe(false);
  });

  it('the same round as a daily round does write them (the hooks ran)', async () => {
    const e = await entrants();
    const r = await seedDailyFree(
      e.users.map((userId, i) => ({ userId, pick: PICKS[i] as 0 | 1 })),
      { author: e.author },
    );
    const before = await globalState();
    await settle(r.roundId);
    expect(await freeMode(r.roundId)).toEqual({ status: 'settled', refund_reason: null });
    const after = await globalState();
    for (const key of ['userStats', 'statsDays', 'statsWins', 'statsWeeks', 'splits'] as const) {
      expect(after[key].length, key).toBeGreaterThan(before[key].length);
    }
    expect(after.referrals.find((x) => x.referee_user_id === e.referee)).toMatchObject({
      status: 'qualified',
      qualified_round_id: r.roundId,
    });
    expect(await balanceOf(e.users[0] as string, 'global')).toBe(1025);
    expect((await listed(r)).has(e.users[0] as string)).toBe(true);
  });
});
