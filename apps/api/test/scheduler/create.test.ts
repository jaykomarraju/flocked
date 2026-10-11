// Daily round creation 48 h ahead (spec "Round lifecycle" › Timing and Scheduling), including DST
// days, and the one-daily-round-per-close-time index (migration 0005).
import { env } from 'cloudflare:test';
import { gameDayOf, isGameDay } from '@flocked/shared';
import { isDailyClose } from '@flocked/tlock';
import { describe, expect, it } from 'vitest';
import { createRoundsAhead, slotsAhead } from '../../src/scheduler/create.js';
import { HOUR } from './helpers.js';

async function dailyRows(fromMs: number, toMs: number) {
  const { results } = await env.DB.prepare(
    "SELECT id, opens_at, closes_at, status, question_id, locked_at FROM rounds WHERE kind = 'daily' AND closes_at > ?1 AND closes_at <= ?2 ORDER BY closes_at",
  )
    .bind(fromMs, toMs)
    .all<{
      id: string;
      opens_at: number;
      closes_at: number;
      status: string;
      question_id: string | null;
      locked_at: number | null;
    }>();
  return results;
}

describe('createRoundsAhead', () => {
  it('creates every daily round opening within 48 h, 21:00 to 21:00 New York, unlocked', async () => {
    const t = Date.UTC(2026, 9, 20, 16, 0, 0); // Oct 20, 2026 12:00 EDT
    const ids = await createRoundsAhead(env, t);
    expect(ids).toHaveLength(3);
    const rows = await dailyRows(t, t + 72 * HOUR);
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(rows.map((r) => gameDayOf(r.closes_at / 1000))).toEqual([
      '2026-10-20', // open now
      '2026-10-21', // opens Oct 20 21:00
      '2026-10-22', // opens Oct 21 21:00, 33 h ahead (Oct 23's opens 57 h ahead)
    ]);
    for (const r of rows) {
      expect(isDailyClose(r.closes_at / 1000, gameDayOf(r.closes_at / 1000))).toBe(true);
      expect(r.closes_at - r.opens_at).toBe(24 * HOUR);
      expect(r).toMatchObject({ status: 'scheduled', question_id: null, locked_at: null });
    }
  });

  it('is idempotent, also when two cron runs overlap', async () => {
    const t = Date.UTC(2026, 10, 20, 17, 0, 0);
    const [a, b] = await Promise.all([createRoundsAhead(env, t), createRoundsAhead(env, t)]);
    expect(a.length + b.length).toBe(3);
    expect(await createRoundsAhead(env, t + HOUR)).toEqual([]);
    expect(await dailyRows(t, t + 72 * HOUR)).toHaveLength(3);
  });

  it('refuses a second daily round with the same close time', async () => {
    const [slot] = slotsAhead(Date.UTC(2027, 0, 10, 17, 0, 0));
    const insert = () =>
      env.DB.prepare(
        "INSERT INTO rounds (id, kind, opens_at, closes_at) VALUES (?1, 'daily', ?2, ?3)",
      )
        .bind(crypto.randomUUID(), slot!.opensAt, slot!.closesAt)
        .run();
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE/);
  });

  it('DST days: the round closing Nov 1, 2026 lasts 25 h, the one closing Mar 14, 2027 23 h', async () => {
    await createRoundsAhead(env, Date.UTC(2026, 9, 31, 16, 0, 0)); // Oct 31, 12:00 EDT
    await createRoundsAhead(env, Date.UTC(2027, 2, 13, 17, 0, 0)); // Mar 13, 12:00 EST
    const byDay = new Map(
      (await dailyRows(0, Date.UTC(2028, 0, 1))).map((r) => [gameDayOf(r.closes_at / 1000), r]),
    );
    const fall = byDay.get('2026-11-01')!;
    expect(fall.closes_at - fall.opens_at).toBe(25 * HOUR);
    expect(fall).toMatchObject({
      opens_at: Date.UTC(2026, 10, 1, 1, 0, 0), // Oct 31 21:00 EDT
      closes_at: Date.UTC(2026, 10, 2, 2, 0, 0), // Nov 1 21:00 EST
    });
    const spring = byDay.get('2027-03-14')!;
    expect(spring.closes_at - spring.opens_at).toBe(23 * HOUR);
    expect(spring).toMatchObject({
      opens_at: Date.UTC(2027, 2, 14, 2, 0, 0), // Mar 13 21:00 EST
      closes_at: Date.UTC(2027, 2, 15, 1, 0, 0), // Mar 14 21:00 EDT
    });
    // Each round opens when the previous one closes.
    expect(byDay.get('2026-10-31')!.closes_at).toBe(fall.opens_at);
    expect(byDay.get('2027-03-13')!.closes_at).toBe(spring.opens_at);
    expect([...byDay.keys()].every(isGameDay)).toBe(true);
  });
});
