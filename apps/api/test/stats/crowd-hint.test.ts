// The crowd-history hint on GET /rounds/today (spec "Client app", Today; W3-Z carry-over): the open
// round's category's mean winning-side share over its last 30 settled daily rounds, per mode,
// hidden until the category has 5. Refunded, voided and unsettled modes, room rounds and other
// categories don't count.
import { env } from 'cloudflare:test';
import { RoundsTodayResponseSchema } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { readCrowdHint, readToday } from '../../src/read/rounds.js';
import { FIXED_NOW, FIXTURE_ROUND, seedFixture } from '../helpers/index.js';
import { seedDay, userId, type SeedEntry } from './helpers.js';

const voters = (h0: number, h1: number): SeedEntry[] =>
  [...Array(h0 + h1).keys()].map((i) => ({
    user: userId(500 + i),
    option: i < h0 ? 0 : 1,
  }));

const settled = (
  day: string,
  h0: number,
  h1: number,
  extra: Parameters<typeof seedDay>[0] = { day, modes: {} },
) =>
  seedDay({
    ...extra,
    day,
    modes: { free: { status: 'settled', entries: voters(h0, h1) }, ...extra.modes },
  });

/** YYYY-MM-DD, `n` days after 2026-07-01. */
const dayAfter = (n: number) =>
  new Date(Date.UTC(2026, 6, 1) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await seedFixture(env.DB); // the open daily round (category food) at FIXED_NOW
});

describe('readCrowdHint', () => {
  it('is hidden below 5 settled rounds, then averages the winning side over the last 30', async () => {
    const before = FIXTURE_ROUND.closesAt;
    for (let i = 0; i < 4; i++) await settled(dayAfter(i), 4, 6);
    expect(await readCrowdHint(env.DB, 'food', before)).toEqual({ free: null, stakes: null });

    await settled(dayAfter(4), 4, 6);
    expect(await readCrowdHint(env.DB, 'food', before)).toEqual({
      free: { category: 'food', winningShare: 0.4, rounds: 5 },
      stakes: null,
    });

    // 25 more at 0.4 and two older ones at 0.1: 32 in all, and only the newest 30 count.
    for (let i = 5; i < 30; i++) await settled(dayAfter(i), 4, 6);
    await settled(dayAfter(-2), 1, 9);
    await settled(dayAfter(-1), 1, 9);
    const hint = await readCrowdHint(env.DB, 'food', before);
    expect(hint.free).toEqual({ category: 'food', winningShare: 0.4, rounds: 30 });
  });

  it('ignores refunded, voided and unsettled modes, room rounds, other categories and later rounds', async () => {
    const before = FIXTURE_ROUND.closesAt;
    const base = await readCrowdHint(env.DB, 'food', before);
    // A refunded mode is left out even with a winner on record.
    const refunded = await seedDay({
      day: dayAfter(40),
      modes: { free: { status: 'refunded', entries: voters(1, 9) } },
    });
    await env.DB.prepare(
      'UPDATE settlements SET winners_json = \'{"winner":0}\' WHERE round_id = ?1',
    )
      .bind(refunded.roundId)
      .run();
    await seedDay({ day: dayAfter(41), modes: { free: { status: 'voided', entries: [] } } });
    await seedDay({
      day: dayAfter(42),
      modes: { free: { status: 'revealing', entries: voters(1, 9) } },
    });
    await seedDay({
      day: dayAfter(43),
      kind: 'room',
      modes: { free: { status: 'settled', entries: voters(1, 9) } },
    });
    await settled(dayAfter(44), 1, 9, { day: dayAfter(44), category: 'tech', modes: {} });
    await settled('2026-12-01', 1, 9); // closes after the open round
    expect(await readCrowdHint(env.DB, 'food', before)).toEqual(base);
    expect((await readCrowdHint(env.DB, 'tech', before)).free).toBeNull();
  });

  it('keeps each mode apart', async () => {
    for (let i = 0; i < 5; i++) {
      await seedDay({
        day: dayAfter(50 + i),
        category: 'pop',
        modes: { stakes: { status: 'settled', entries: voters(2, 3) } },
      });
    }
    expect(await readCrowdHint(env.DB, 'pop', FIXTURE_ROUND.closesAt)).toEqual({
      free: null,
      stakes: { category: 'pop', winningShare: 0.4, rounds: 5 },
    });
  });
});

describe('GET /rounds/today', () => {
  it("carries the open round's hint", async () => {
    const body = RoundsTodayResponseSchema.parse(
      JSON.parse(JSON.stringify(await readToday(env, FIXED_NOW))),
    );
    expect(body.round?.question.category).toBe('food');
    expect(body.crowdHint).toEqual({
      free: { category: 'food', winningShare: 0.4, rounds: 30 },
      stakes: null,
    });
    // A schedule gap has no round and no hint.
    expect((await readToday(env, Date.UTC(2030, 0, 1))).crowdHint).toBeNull();
  });
});
