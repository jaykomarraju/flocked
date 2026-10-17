// The post-final hooks (src/settlement/hooks.ts) and the stats handler's idempotency: a retried
// settlement calls every handler again, concurrent calls race, and a batch can fail halfway
// through a day. Each entrant must still be counted exactly once. Also: a failing handler fails the
// call (so the caller retries) without stopping the others, room rounds never touch global stats,
// and Free's rule-8 refund runs the hooks.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refundFree, type FreeApplyDeps } from '../../src/settlement/apply/free.js';
import { onModeFinal, runModeFinal, type ModeFinalEvent } from '../../src/settlement/hooks.js';
import { schedulerTick } from '../../src/scheduler/tick.js';
import { STATS_SIZES, applyFinalDays } from '../../src/stats/apply.js';
import { resetTables, seedDay, seedUser, statsOf, userId } from './helpers.js';

/** Pins the shared env's clock (the scheduler reads it). */
const setTestClock = (ms: number) =>
  Object.assign(env, { ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(ms) });

const T = Date.UTC(2027, 5, 1);
const USERS = [1, 2, 3, 4, 5, 6, 7].map(userId);

beforeEach(async () => {
  await resetTables();
  for (let n = 1; n <= USERS.length; n++) await seedUser(n);
});

afterEach(() => {
  vi.restoreAllMocks();
  STATS_SIZES.chunk = 1000;
});

/** Three settled days: users 1–3 win day 1 and day 3, users 4–7 win day 2. */
async function seedThreeDays(): Promise<string[]> {
  const ids: string[] = [];
  const day = async (d: string, winners: string[]) =>
    ids.push(
      (
        await seedDay({
          day: d,
          modes: {
            free: {
              status: 'settled',
              winner: 0,
              entries: USERS.map((u) => ({ user: u, option: winners.includes(u) ? 0 : 1 })),
            },
          },
        })
      ).roundId,
    );
  await day('2026-10-05', USERS.slice(0, 3));
  await day('2026-10-06', USERS.slice(3));
  await day('2026-10-07', USERS.slice(0, 3));
  return ids;
}

async function snapshot() {
  const q = (sql: string) =>
    env.DB.prepare(sql)
      .all()
      .then((r) => r.results);
  return {
    stats: await q('SELECT * FROM user_stats ORDER BY user_id, mode'),
    wins: await q('SELECT * FROM stats_wins ORDER BY round_id, user_id'),
    weeks: await q('SELECT * FROM stats_weeks ORDER BY user_id, iso_week'),
    days: await q('SELECT round_id, outcome, done_at FROM stats_days ORDER BY closes_at'),
  };
}

const EXPECTED_U1 = {
  rounds_played: 3,
  wins: 2,
  losses: 1,
  refunds: 0,
  stray_streak: 1,
  best_stray_streak: 1,
  play_streak: 3,
  net: 100,
};

describe('idempotency', () => {
  it('a retried hook call changes nothing', async () => {
    const [first] = await seedThreeDays();
    const event: ModeFinalEvent = {
      roundId: first ?? '',
      mode: 'free',
      kind: 'daily',
      outcome: 'settled',
    };
    await runModeFinal(env, event);
    const once = await snapshot();
    expect(once.days).toHaveLength(3);
    await runModeFinal(env, event);
    await runModeFinal(env, event);
    expect(await snapshot()).toEqual(once);
    expect(await statsOf(USERS[0] ?? '')).toEqual(EXPECTED_U1);
  });

  it('concurrent calls over small chunks count every entrant once', async () => {
    await seedThreeDays();
    STATS_SIZES.chunk = 2;
    const finished = await Promise.all(
      [1, 2, 3, 4, 5].map(() => applyFinalDays(env.DB, 'free', T)),
    );
    // Each day is finished by one call or another; together exactly three.
    expect(finished.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3);
    const s = await snapshot();
    expect(s.days.map((d) => d.outcome)).toEqual(['settled', 'settled', 'settled']);
    expect(await statsOf(USERS[0] ?? '')).toEqual(EXPECTED_U1);
    expect(await statsOf(USERS[6] ?? '')).toMatchObject({ rounds_played: 3, wins: 1, losses: 2 });
    expect(s.wins).toHaveLength(3 + 4 + 3);
  });

  it('a batch that fails halfway through a day is resumed, not repeated', async () => {
    await seedThreeDays();
    STATS_SIZES.chunk = 2;
    const real = env.DB.batch.bind(env.DB);
    let calls = 0;
    vi.spyOn(env.DB, 'batch').mockImplementation(async (stmts) => {
      calls += 1;
      if (calls === 3) throw new Error('D1 went away');
      return real(stmts);
    });
    await expect(applyFinalDays(env.DB, 'free', T)).rejects.toThrow('D1 went away');
    expect(await applyFinalDays(env.DB, 'free', T)).toBe(3);
    vi.restoreAllMocks();
    expect(await statsOf(USERS[0] ?? '')).toEqual(EXPECTED_U1);
    for (const u of USERS) {
      expect((await statsOf(u))?.rounds_played).toBe(3);
    }
  });
});

describe('runModeFinal', () => {
  it('runs every handler, then fails the call when one failed', async () => {
    const [first] = await seedThreeDays();
    const seen: string[] = [];
    const offs = [
      onModeFinal(() => Promise.reject(new Error('creator credit down'))),
      onModeFinal((_env, e) => {
        seen.push(`${e.roundId}:${e.mode}`);
        return Promise.resolve();
      }),
    ];
    try {
      await expect(
        runModeFinal(env, {
          roundId: first ?? '',
          mode: 'free',
          kind: 'daily',
          outcome: 'settled',
        }),
      ).rejects.toThrow(/1 mode-final hook\(s\) failed/);
    } finally {
      for (const off of offs) off();
    }
    expect(seen).toEqual([`${first}:free`]);
    // The stats handler ran too.
    expect(await statsOf(USERS[0] ?? '')).toEqual(EXPECTED_U1);
  });

  it('a settled day without its settlement stops the stats and alerts, but fails no settlement', async () => {
    const broken = await seedDay({
      day: '2026-10-05',
      modes: {
        free: { status: 'settled', winner: 0, entries: [{ user: USERS[0] ?? '', option: 0 }] },
      },
    });
    await env.DB.prepare('DELETE FROM settlements WHERE round_id = ?1').bind(broken.roundId).run();
    const later = await seedDay({
      day: '2026-10-06',
      modes: {
        free: { status: 'settled', winner: 0, entries: [{ user: USERS[0] ?? '', option: 0 }] },
      },
    });
    const writes = vi.spyOn(env.ANALYTICS, 'writeDataPoint');
    await runModeFinal(env, {
      roundId: later.roundId,
      mode: 'free',
      kind: 'daily',
      outcome: 'settled',
    });
    expect(writes.mock.calls.map((c) => (c[0] as { indexes: string[] }).indexes[0])).toContain(
      'ALERT_DO_ERROR',
    );
    expect((await snapshot()).days).toEqual([]);
    expect(await statsOf(USERS[0] ?? '')).toBeNull();
  });

  it('a room round never touches global stats', async () => {
    const room = await seedDay({
      day: '2026-10-05',
      kind: 'room',
      modes: {
        free: { status: 'settled', winner: 0, entries: [{ user: USERS[0] ?? '', option: 0 }] },
      },
    });
    await runModeFinal(env, {
      roundId: room.roundId,
      mode: 'free',
      kind: 'room',
      outcome: 'settled',
    });
    expect((await snapshot()).stats).toEqual([]);
  });
});

describe('Free apply wiring', () => {
  it("rule 8's refund runs the hooks: the refunded day counts as played", async () => {
    const r = await seedDay({
      day: '2026-10-05',
      modes: {
        free: {
          status: 'pending',
          entries: [
            { user: USERS[0] ?? '', option: 0 },
            { user: USERS[1] ?? '', option: 1 },
          ],
        },
      },
    });
    const deps: FreeApplyDeps = { notifyRound: async () => {}, anchorManifest: async () => {} };
    await refundFree(env, r.roundId, 8, deps);
    expect(await statsOf(USERS[0] ?? '')).toMatchObject({
      rounds_played: 1,
      refunds: 1,
      stray_streak: 0,
      play_streak: 1,
      net: 0,
    });
    const day = await env.DB.prepare('SELECT outcome, done_at FROM stats_days WHERE round_id = ?1')
      .bind(r.roundId)
      .first<{ outcome: string; done_at: number | null }>();
    expect(day?.outcome).toBe('refunded');
    expect(day?.done_at).not.toBeNull();
  });
});

describe('a Stakes call is bounded (W8-F1 L5)', () => {
  it(`applies at most ${STATS_SIZES.stakesBatches} batches; the scheduler tick drains the rest`, async () => {
    for (const day of ['2027-05-03', '2027-05-04', '2027-05-05']) {
      await seedDay({
        day,
        modes: {
          stakes: {
            status: 'settled',
            winner: 0,
            entries: USERS.map((u, i) => ({ user: u, option: i < 3 ? 0 : 1 })),
          },
        },
      });
    }
    // 7 entrants in chunks of 2: each day is 4 chunks and its closing batch, 15 batches in all.
    STATS_SIZES.chunk = 2;
    const doneDays = async () =>
      (await snapshot()).days.filter((d) => (d as { done_at: number | null }).done_at !== null)
        .length;
    expect(await applyFinalDays(env.DB, 'stakes', T)).toBe(1);
    expect(await doneDays()).toBe(1);
    // A Free call is not bounded that way (its hook runs outside the indexer's poll).
    expect(await applyFinalDays(env.DB, 'free', T)).toBe(0);

    setTestClock(T);
    await schedulerTick(env);
    expect(await doneDays()).toBe(3);
    for (const u of USERS) {
      expect((await statsOf(u, 'stakes'))?.rounds_played).toBe(3);
    }
    expect(await statsOf(USERS[0] ?? '', 'stakes')).toMatchObject({ wins: 3, stray_streak: 3 });
  });
});
