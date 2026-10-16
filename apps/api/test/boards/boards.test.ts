// GET /leaderboards/:board (spec "Profiles, leaderboards and rooms" › Leaderboards): the ranking and
// every tie-break of each board, the period and mode filters, the caller's own row, and the listing
// rule (verified and active only: unverified, merged and deleted accounts never appear).
import { env } from 'cloudflare:test';
import { LeaderboardResponseSchema, type LeaderboardResponse } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { boards } from '../../src/routes/boards.js';
import { applyFinalDays } from '../../src/stats/apply.js';
import { fakeUser, withSession } from '../helpers/index.js';
import { resetTables, seedDay, seedUser, userId } from '../stats/helpers.js';

const u = userId;
const U1 = u(1);
const U2 = u(2);
const U3 = u(3);
const U4 = u(4);
const U5 = u(5);
const U6 = u(6);
const U7 = u(7);
const U8 = u(8);
const U9 = u(9);
const U10 = u(10);

async function get(path: string, viewer?: string): Promise<Response> {
  const app = withSession(boards, viewer ? fakeUser({ id: viewer }) : undefined);
  return app.request(path, {}, env);
}

async function board(path: string, viewer?: string): Promise<LeaderboardResponse> {
  const res = await get(path, viewer);
  expect(res.status).toBe(200);
  return LeaderboardResponseSchema.parse(await res.json());
}

const ranks = (b: LeaderboardResponse) => b.rows.map((r) => [r.rank, r.user.id]);

const day = (d: string, winners: string[], losers: string[]) =>
  seedDay({
    day: d,
    modes: {
      free: {
        status: 'settled',
        winner: 0,
        entries: [
          ...winners.map((user) => ({ user, option: 0 as const })),
          ...losers.map((user) => ({ user, option: 1 as const })),
        ],
      },
    },
  });

/** A used question's daily round with one revealed, final mode and the given headcounts. */
const question = (
  d: string,
  author: string,
  h0: number,
  h1: number,
  mode: 'free' | 'stakes' = 'free',
) => {
  const voters = [...Array(h0 + h1).keys()].map((i) => u(100 + i));
  return seedDay({
    day: d,
    author,
    modes: {
      [mode]: {
        status: h0 === h1 ? 'refunded' : 'settled',
        entries: voters.map((user, i) => ({ user, option: i < h0 ? 0 : 1 })),
      },
    },
  });
};

beforeAll(async () => {
  await resetTables();
  for (const n of [1, 2, 3, 4, 8, 9, 10]) await seedUser(n);
  await seedUser(5, { verified: false });
  await seedUser(6, { status: 'merged' });
  await seedUser(7, { status: 'deleted', handle: null });
  // A person ID without a verified KYC status is not verified either.
  await seedUser(11);
  await env.DB.prepare("UPDATE users SET kyc_status = 'pending' WHERE id = ?1").bind(u(11)).run();
  // Stray streaks after 10-08: U1 3 (best 3), U4 2 (2), U3 1 (best 2), U2 and U9 1 (1) over three
  // rounds, U10 1 (1) over one round; U8 never won.
  await day('2026-10-05', [U3], [U8]);
  await day('2026-10-06', [U1, U2, U3, U9], [U4, U8]);
  await day('2026-10-07', [U1, U4], [U2, U3, U9, U8]);
  // Entry order is the list order: U9 enters before U2.
  await day('2026-10-08', [U1, U4, U3, U9, U2, U5, U6, U7, U10, u(11)], [U8]);
  expect(await applyFinalDays(env.DB, 'free', Date.UTC(2026, 9, 9))).toBe(4);

  // Creators (voters 100+ are unlisted users with no row; the boards above ignore them).
  for (const n of [21, 22, 23, 24]) await seedUser(n);
  await seedUser(25, { verified: false });
  await question('2026-11-02', u(21), 3, 1); // 0.5
  // A refunded tie: not counted, settled modes only (W8-F1 L6). Counted, its 1.0 would make u21
  // first with 3 used questions (mean 0.77).
  await question('2026-11-03', u(21), 2, 2);
  await question('2026-11-17', u(21), 2, 3); // 0.8
  await question('2026-11-04', u(22), 2, 1); // 2/3
  await question('2026-11-05', u(22), 1, 2); // 2/3
  await question('2026-11-06', u(22), 4, 5); // 8/9
  await question('2026-11-07', u(23), 2, 3); // 0.8
  await question('2026-11-08', u(23), 9, 11); // 0.9
  await question('2026-11-09', u(23), 7, 1); // 0.25
  await question('2026-11-10', u(24), 1, 2); // one used question only
  await question('2026-11-11', u(25), 1, 2); // unverified
  await question('2026-11-12', u(25), 2, 1);
  await question('2026-11-13', u(24), 1, 3, 'stakes'); // 0.5
  await question('2026-11-14', u(24), 2, 3, 'stakes'); // 0.8
  // Not counted: a voided round's question and a pending one.
  await seedDay({
    day: '2026-11-15',
    author: u(24),
    modes: { free: { status: 'voided', entries: [] } },
  });
  await seedDay({
    day: '2026-11-16',
    author: u(24),
    modes: { free: { status: 'pending', entries: [] } },
  });
});

describe('strays', () => {
  it("ranks the day's winners by stray streak, then best stray streak, then entry time", async () => {
    const b = await board('/leaderboards/strays');
    expect(b).toMatchObject({ board: 'strays', mode: 'free', period: '2026-10-08', me: null });
    expect(ranks(b)).toEqual([
      [1, U1],
      [2, U4],
      [3, U3],
      [4, U9],
      [5, U2],
      [6, U10],
    ]);
    expect(b.rows[2]).toMatchObject({ strayStreak: 1, bestStrayStreak: 2 });
    expect(b.rows[3]?.enteredAt).toBeLessThan(b.rows[4]?.enteredAt ?? 0);
  });

  it('a past game day shows the streaks its winners had that day', async () => {
    const b = await board('/leaderboards/strays?period=2026-10-06');
    expect(b.period).toBe('2026-10-06');
    expect(b.rows.map((r) => [r.rank, r.user.id, r.strayStreak])).toEqual([
      [1, U3, 2],
      [2, U1, 1],
      [3, U2, 1],
      [4, U9, 1],
    ]);
    const none = await board('/leaderboards/strays?period=2026-09-01');
    expect(none).toMatchObject({ period: '2026-09-01', rows: [], me: null });
  });

  it('gives a listed caller their own row and rank, and an unlisted one none', async () => {
    expect((await board('/leaderboards/strays', U2)).me).toMatchObject({
      rank: 5,
      user: { id: U2 },
    });
    expect((await board('/leaderboards/strays', U5)).me).toBeNull();
    expect((await board('/leaderboards/strays', U8)).me).toBeNull();
  });

  it('refuses an ISO week; the Stakes board has no day yet', async () => {
    expect((await get('/leaderboards/strays?period=2026-W41')).status).toBe(400);
    expect(await board('/leaderboards/strays?mode=stakes')).toMatchObject({
      mode: 'stakes',
      period: null,
      rows: [],
    });
  });
});

describe('streaks', () => {
  it('ranks the best stray streak, then the current streak, then rounds played; full ties share a rank', async () => {
    const b = await board('/leaderboards/streaks', U10);
    expect(b.period).toBeNull();
    expect(
      b.rows.map((r) => [r.rank, r.user.id, r.bestStrayStreak, r.strayStreak, r.roundsPlayed]),
    ).toEqual([
      [1, U1, 3, 3, 3],
      [2, U4, 2, 2, 3],
      [3, U3, 2, 1, 4],
      [4, U2, 1, 1, 3],
      [4, U9, 1, 1, 3],
      [6, U10, 1, 1, 1],
    ]);
    expect(b.me).toMatchObject({ rank: 6, user: { id: U10 } });
    expect(b.rows.filter((r) => r.topLiveStreak).map((r) => r.user.id)).toEqual([U1]);
  });
});

describe('weekly', () => {
  it('ranks wins in the ISO week of the game day, then net; ties share a rank', async () => {
    const b = await board('/leaderboards/weekly', U9);
    expect(b.period).toBe('2026-W41');
    expect(b.rows.map((r) => [r.rank, r.user.id, r.wins, r.net])).toEqual([
      [1, U1, 3, '300'],
      [2, U3, 3, '200'],
      [3, U2, 2, '100'],
      [3, U4, 2, '100'],
      [3, U9, 2, '100'],
      [6, U10, 1, '100'],
    ]);
    expect(b.me).toMatchObject({ rank: 3, wins: 2, net: '100' });
    expect(await board('/leaderboards/weekly?period=2026-W42')).toMatchObject({
      period: '2026-W42',
      rows: [],
    });
    expect((await get('/leaderboards/weekly?period=2026-10-08')).status).toBe(400);
  });
});

describe('creators', () => {
  it('ranks mean split quality over at least two used questions, then the number used', async () => {
    const b = await board('/leaderboards/creators', u(21));
    expect(b.rows.map((r) => [r.rank, r.user.id, r.usedQuestions])).toEqual([
      [1, u(22), 3],
      [2, u(23), 3],
      [3, u(21), 2],
    ]);
    expect(b.rows[0]?.splitQuality).toBeCloseTo(20 / 27, 10);
    expect(b.rows[1]?.splitQuality).toBeCloseTo(0.65, 10);
    expect(b.rows[2]?.splitQuality).toBeCloseTo(0.65, 10);
    expect(b.me).toMatchObject({ rank: 3, user: { id: u(21) } });
  });

  it('has a mode filter', async () => {
    const b = await board('/leaderboards/creators?mode=stakes');
    expect(b.rows.map((r) => [r.rank, r.user.id, r.usedQuestions])).toEqual([[1, u(24), 2]]);
    expect(b.rows[0]?.splitQuality).toBeCloseTo(0.65, 10);
  });
});

describe('listing', () => {
  it('no board lists an unverified, merged or deleted account', async () => {
    const hidden = new Set([U5, U6, U7, u(11), u(25)]);
    for (const path of [
      '/leaderboards/strays',
      '/leaderboards/streaks',
      '/leaderboards/weekly',
      '/leaderboards/creators',
    ]) {
      const b = await board(path);
      expect(b.rows.length).toBeGreaterThan(0);
      expect(b.rows.filter((r) => hidden.has(r.user.id))).toEqual([]);
    }
  });

  it('answers 400 for an unknown board or mode', async () => {
    expect((await get('/leaderboards/richest')).status).toBe(400);
    expect((await get('/leaderboards/streaks?mode=gold')).status).toBe(400);
  });
});
