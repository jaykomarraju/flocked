// Two board details (spec "Profiles, leaderboards and rooms"): the Streaks board's accent pill marks
// the top live streak, which need not be the top-ranked row, and the Stakes weekly board keeps a
// user's net private unless they show it, while still breaking ties by it.
import { env } from 'cloudflare:test';
import { LeaderboardResponseSchema, type LeaderboardResponse } from '@flocked/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { boards } from '../../src/routes/boards.js';
import { applyFinalDays } from '../../src/stats/apply.js';
import { fakeUser, withSession } from '../helpers/index.js';
import { resetTables, seedDay, seedUser, userId } from '../stats/helpers.js';

async function board(path: string, viewer?: string): Promise<LeaderboardResponse> {
  const app = withSession(boards, viewer ? fakeUser({ id: viewer }) : undefined);
  const res = await app.request(path, {}, env);
  expect(res.status).toBe(200);
  return LeaderboardResponseSchema.parse(await res.json());
}

beforeEach(resetTables);

describe('the Streaks pill', () => {
  it("wraps the highest current streak shown, not the best streak's row", async () => {
    for (const n of [1, 2, 3]) await seedUser(n);
    const row = (n: number, best: number, stray: number, rounds: number) =>
      env.DB.prepare(
        `INSERT INTO user_stats (user_id, mode, rounds_played, wins, stray_streak, best_stray_streak,
           play_streak, updated_at) VALUES (?1, 'free', ?2, ?3, ?4, ?5, 0, 1)`,
      )
        .bind(userId(n), rounds, best, stray, best)
        .run();
    await row(1, 9, 0, 30);
    await row(2, 4, 4, 10);
    await row(3, 4, 4, 8);
    const b = await board('/leaderboards/streaks');
    expect(b.rows.map((r) => [r.rank, r.user.id, r.topLiveStreak ?? false])).toEqual([
      [1, userId(1), false],
      [2, userId(2), true], // tied on the live streak with rank 3: the first by rank
      [3, userId(3), false],
    ]);
  });

  it('marks no row while every current streak is 0', async () => {
    await seedUser(1);
    await env.DB.prepare(
      `INSERT INTO user_stats (user_id, mode, rounds_played, wins, stray_streak, best_stray_streak,
         play_streak, updated_at) VALUES (?1, 'free', 3, 2, 0, 2, 0, 1)`,
    )
      .bind(userId(1))
      .run();
    const b = await board('/leaderboards/streaks');
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]?.topLiveStreak).toBeUndefined();
  });
});

describe('Stakes net on the weekly board', () => {
  it('is shown only for users who show it, and still breaks the tie', async () => {
    await seedUser(1, { prefs: { show_stakes_net: true } });
    await seedUser(2);
    await seedUser(3);
    await seedDay({
      day: '2026-10-05',
      modes: {
        stakes: {
          status: 'settled',
          winner: 0,
          entries: [
            { user: userId(1), option: 0, stake: 5_000_000, payout: 7_000_000 },
            { user: userId(2), option: 0, stake: 5_000_000, payout: 9_000_000 },
            { user: userId(3), option: 1, stake: 5_000_000, payout: 0 },
          ],
        },
        free: {
          status: 'settled',
          winner: 0,
          entries: [
            { user: userId(2), option: 0 },
            { user: userId(3), option: 1 },
          ],
        },
      },
    });
    await applyFinalDays(env.DB, 'stakes', Date.UTC(2026, 9, 6));
    await applyFinalDays(env.DB, 'free', Date.UTC(2026, 9, 6));

    const stakes = await board('/leaderboards/weekly?mode=stakes', userId(2));
    expect(stakes.rows.map((r) => [r.rank, r.user.id, r.net ?? null])).toEqual([
      [1, userId(2), null], // net 4 USDC, private
      [2, userId(1), '2000000'], // net 2 USDC, shown
    ]);
    // The caller's own row carries their own net.
    expect(stakes.me).toMatchObject({ rank: 1, net: '4000000' });
    // Free net is public.
    const free = await board('/leaderboards/weekly');
    expect(free.rows.map((r) => [r.user.id, r.net])).toEqual([[userId(2), '100']]);
  });
});
