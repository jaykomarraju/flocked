// Game-day streak rules (spec "Profiles, leaderboards and rooms" › Game day and streaks): wins and
// losses, refunded and voided days neutral for the stray streak (entered or not) while a refunded
// entry still counts as played, a game day with no daily round neutral for both streaks, room
// rounds never counted, days applied in game-day order whatever order they become final in, and the
// New York game day across both DST changes.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyFinalDays } from '../../src/stats/apply.js';
import { finalizeMode, resetTables, seedDay, seedUser, statsOf, userId } from './helpers.js';

const T = Date.UTC(2027, 5, 1);
const apply = (mode: 'free' | 'stakes' = 'free') => applyFinalDays(env.DB, mode, T);

const u1 = userId(1);
const u2 = userId(2);
const u3 = userId(3);

beforeEach(async () => {
  await resetTables();
  await seedUser(1);
  await seedUser(2);
  await seedUser(3);
});

const win = (user: string, option: 0 | 1 = 0) => ({ user, option });
const lose = (user: string, option: 0 | 1 = 1) => ({ user, option });

describe('settled days', () => {
  it('a win extends the stray streak, a loss ends it, and the best keeps the peak', async () => {
    await seedDay({
      day: '2026-10-05',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u2), lose(u3)] } },
    });
    await seedDay({
      day: '2026-10-06',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u2), lose(u3)] } },
    });
    await seedDay({
      day: '2026-10-07',
      modes: { free: { status: 'settled', winner: 0, entries: [lose(u1), win(u2), lose(u3)] } },
    });
    await seedDay({
      day: '2026-10-08',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u2), lose(u3)] } },
    });
    expect(await apply()).toBe(4);
    expect(await statsOf(u1)).toEqual({
      rounds_played: 4,
      wins: 3,
      losses: 1,
      refunds: 0,
      stray_streak: 1,
      best_stray_streak: 2,
      play_streak: 4,
      net: 3 * 100 - 100,
    });
    expect(await statsOf(u2)).toMatchObject({
      wins: 1,
      losses: 3,
      stray_streak: 0,
      best_stray_streak: 1,
    });
  });

  it('an invalid entry is played and refunded but ends the stray streak', async () => {
    await seedDay({
      day: '2026-10-05',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u2), lose(u3)] } },
    });
    await seedDay({
      day: '2026-10-06',
      modes: {
        free: {
          status: 'settled',
          winner: 0,
          entries: [{ user: u1, option: 0, valid: 0, payout: 100 }, win(u2), lose(u3)],
        },
      },
    });
    await apply();
    expect(await statsOf(u1)).toMatchObject({
      rounds_played: 2,
      wins: 1,
      refunds: 1,
      stray_streak: 0,
      best_stray_streak: 1,
      play_streak: 2,
      net: 100,
    });
  });

  it('missing a settled day ends both streaks', async () => {
    await seedDay({
      day: '2026-10-05',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), win(u2), lose(u3)] } },
    });
    await seedDay({
      day: '2026-10-06',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u2), lose(u3)] } },
    });
    await apply();
    expect(await statsOf(u1)).toMatchObject({
      rounds_played: 1,
      stray_streak: 0,
      best_stray_streak: 1,
      play_streak: 0,
    });
    expect(await statsOf(u2)).toMatchObject({ stray_streak: 2, play_streak: 2 });
  });
});

describe('neutral days', () => {
  it('refunded and voided days neither break nor extend the stray streak; a refunded entry still counts as played', async () => {
    await seedDay({
      day: '2026-10-05',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), win(u2), lose(u3)] } },
    });
    await seedDay({
      day: '2026-10-06',
      modes: {
        free: { status: 'refunded', entries: [{ user: u1, option: 0, payout: 100 }, lose(u3)] },
      },
    });
    await seedDay({
      day: '2026-10-07',
      modes: {
        free: { status: 'voided', entries: [{ user: u1, option: 1, payout: 100 }, lose(u3)] },
      },
    });
    await seedDay({
      day: '2026-10-08',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), win(u2), lose(u3)] } },
    });
    expect(await apply()).toBe(4);
    // Entered every day: two wins around two neutral days, all four played.
    expect(await statsOf(u1)).toEqual({
      rounds_played: 4,
      wins: 2,
      losses: 0,
      refunds: 2,
      stray_streak: 2,
      best_stray_streak: 2,
      play_streak: 4,
      net: 200,
    });
    // Absent on the neutral days: the stray streak survives them, the play streak does not.
    expect(await statsOf(u2)).toMatchObject({
      rounds_played: 2,
      stray_streak: 2,
      best_stray_streak: 2,
      play_streak: 1,
    });
  });

  it('a game day with no daily round is neutral for both streaks; a room round never counts', async () => {
    await seedDay({
      day: '2026-10-05',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u3)] } },
    });
    // 2026-10-06: no daily round at all (nothing could be locked), only a room round u1 lost.
    await seedDay({
      day: '2026-10-06',
      kind: 'room',
      modes: { free: { status: 'settled', winner: 0, entries: [lose(u1), win(u3)] } },
    });
    // 2026-10-07: a daily round with a Stakes mode only is not a Free day.
    await seedDay({
      day: '2026-10-07',
      modes: { stakes: { status: 'settled', winner: 0, entries: [win(u2), lose(u3)] } },
    });
    await seedDay({
      day: '2026-10-08',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u3)] } },
    });
    expect(await apply()).toBe(2);
    expect(await statsOf(u1)).toMatchObject({
      rounds_played: 2,
      wins: 2,
      losses: 0,
      stray_streak: 2,
      play_streak: 2,
    });
    expect(await statsOf(u1, 'stakes')).toBeNull();
    expect(await apply('stakes')).toBe(1);
    expect(await statsOf(u2, 'stakes')).toMatchObject({ wins: 1, stray_streak: 1 });
    expect(await statsOf(u2)).toBeNull();
  });
});

describe('order of finality', () => {
  it('a day that becomes final late holds the later days back, then they apply in order', async () => {
    await seedDay({
      day: '2026-10-05',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u3)] } },
    });
    const late = await seedDay({
      day: '2026-10-06',
      modes: { free: { status: 'revealing', entries: [lose(u1), win(u3, 0)] } },
    });
    await seedDay({
      day: '2026-10-07',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u3)] } },
    });
    expect(await apply()).toBe(1);
    expect(await statsOf(u1)).toMatchObject({ rounds_played: 1, stray_streak: 1 });

    await finalizeMode(late.roundId, 'free', 'settled', 0);
    expect(await apply()).toBe(2);
    // Applied out of order, 10-07's win would have made it 2 before 10-06's loss reset it.
    expect(await statsOf(u1)).toMatchObject({
      rounds_played: 3,
      wins: 2,
      losses: 1,
      stray_streak: 1,
      best_stray_streak: 1,
    });
    expect(await apply()).toBe(0);
  });

  it('a pending Stakes day does not hold Free back', async () => {
    await seedDay({
      day: '2026-10-05',
      modes: {
        free: { status: 'settled', winner: 0, entries: [win(u1), lose(u3)] },
        stakes: { status: 'pending', entries: [win(u1), lose(u3)] },
      },
    });
    await seedDay({
      day: '2026-10-06',
      modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u3)] } },
    });
    expect(await apply('free')).toBe(2);
    expect(await apply('stakes')).toBe(0);
    expect(await statsOf(u1)).toMatchObject({ stray_streak: 2 });
    expect(await statsOf(u1, 'stakes')).toBeNull();
  });
});

describe('game days across DST', () => {
  it('fall back (Nov 1, 2026): the streak runs on, and Sunday 21:00 EST is still Sunday in week 44', async () => {
    const days = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'];
    const ids: string[] = [];
    for (const day of days) {
      ids.push(
        (
          await seedDay({
            day,
            modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u3)] } },
          })
        ).roundId,
      );
    }
    expect(await apply()).toBe(4);
    expect(await statsOf(u1)).toMatchObject({
      stray_streak: 4,
      best_stray_streak: 4,
      play_streak: 4,
    });
    const { results } = await env.DB.prepare(
      "SELECT round_id, game_day FROM stats_days WHERE mode = 'free' ORDER BY closes_at",
    ).all<{ round_id: string; game_day: string }>();
    // Nov 1's round closes at 02:00 UTC on Nov 2: its game day is the New York date.
    expect(results).toEqual(days.map((d, i) => ({ round_id: ids[i], game_day: d })));
    const weeks = await env.DB.prepare(
      'SELECT iso_week, wins, net FROM stats_weeks WHERE user_id = ?1 ORDER BY iso_week',
    )
      .bind(u1)
      .all<{ iso_week: string; wins: number; net: number }>();
    expect(weeks.results).toEqual([
      { iso_week: '2026-W44', wins: 3, net: 300 },
      { iso_week: '2026-W45', wins: 1, net: 100 },
    ]);
  });

  it('spring forward (Mar 14, 2027): the streak runs on, and the week turns on Monday', async () => {
    for (const day of ['2027-03-13', '2027-03-14', '2027-03-15']) {
      await seedDay({
        day,
        modes: { free: { status: 'settled', winner: 0, entries: [win(u1), lose(u3)] } },
      });
    }
    expect(await apply()).toBe(3);
    expect(await statsOf(u1)).toMatchObject({ stray_streak: 3, play_streak: 3 });
    const weeks = await env.DB.prepare(
      'SELECT iso_week, wins FROM stats_weeks WHERE user_id = ?1 ORDER BY iso_week',
    )
      .bind(u1)
      .all<{ iso_week: string; wins: number }>();
    expect(weeks.results).toEqual([
      { iso_week: '2027-W10', wins: 2 },
      { iso_week: '2027-W11', wins: 1 },
    ]);
  });
});

describe('modes and net', () => {
  it('Stakes keeps its own row and its net in USDC base units', async () => {
    await seedDay({
      day: '2026-10-05',
      modes: {
        free: { status: 'settled', winner: 0, entries: [win(u1), lose(u2)] },
        stakes: {
          status: 'settled',
          winner: 1,
          entries: [
            { user: u1, option: 0, stake: 5_000_000, payout: 400_000 },
            { user: u2, option: 1, stake: 5_000_000, payout: 9_200_000 },
          ],
        },
      },
    });
    await apply('free');
    await apply('stakes');
    expect(await statsOf(u1)).toMatchObject({ wins: 1, net: 100 });
    expect(await statsOf(u1, 'stakes')).toMatchObject({ wins: 0, losses: 1, net: -4_600_000 });
    expect(await statsOf(u2, 'stakes')).toMatchObject({ wins: 1, stray_streak: 1, net: 4_200_000 });
  });

  it('a foreign entry (no user) counts for no one', async () => {
    await seedDay({
      day: '2026-10-05',
      modes: {
        stakes: {
          status: 'settled',
          winner: 0,
          entries: [{ user: u1, option: 0, foreign: true }, lose(u2)],
        },
      },
    });
    await apply('stakes');
    const { results } = await env.DB.prepare(
      "SELECT user_id FROM user_stats WHERE mode = 'stakes'",
    ).all();
    expect(results).toEqual([{ user_id: u2 }]);
  });
});
