// Daily round creation (spec "Round lifecycle" › Scheduling: a scheduler cron creates rounds in D1 48
// hours ahead; Timing: 21:00 to 21:00 America/New_York, 23 or 25 hours on DST change days).
// Idempotent: `rounds_daily_closes_at` (migration 0005) keeps one daily round per close time, so
// overlapping cron runs insert each game day once.
import { addGameDays, dailyClosesAt, dailyOpensAt, newUlid, openGameDayAt } from '@flocked/shared';
import type { Env } from '../env.js';
import { HOUR_MS } from '../rounds/schedule.js';

/** Rounds exist in D1 this far ahead of their `opensAt`. */
export const CREATE_AHEAD_MS = 48 * HOUR_MS;

export interface DailySlot {
  gameDay: string;
  /** Epoch ms. */
  opensAt: number;
  closesAt: number;
}

/** The daily round of `gameDay`: opens 21:00 New York the day before, closes 21:00 that day. */
export function dailySlot(gameDay: string): DailySlot {
  return {
    gameDay,
    opensAt: dailyOpensAt(gameDay) * 1000,
    closesAt: dailyClosesAt(gameDay) * 1000,
  };
}

/** Every daily slot from the one open at `t` through the last that opens by `t + aheadMs`. */
export function slotsAhead(t: number, aheadMs = CREATE_AHEAD_MS): DailySlot[] {
  const slots: DailySlot[] = [];
  for (let day = openGameDayAt(Math.floor(t / 1000)); ; day = addGameDays(day, 1)) {
    const slot = dailySlot(day);
    if (slot.opensAt > t + aheadMs) return slots;
    slots.push(slot);
  }
}

/** Inserts the slot's daily round unless one exists; returns the new round's ID, or null. */
export async function insertDailyRound(db: D1Database, slot: DailySlot): Promise<string | null> {
  const id = newUlid();
  const res = await db
    .prepare(
      "INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, status) VALUES (?1, 'daily', NULL, NULL, ?2, ?3, 'scheduled') ON CONFLICT DO NOTHING",
    )
    .bind(id, slot.opensAt, slot.closesAt)
    .run();
  return res.meta.changes === 1 ? id : null;
}

/**
 * The hourly job: creates every missing daily round that opens within 48 hours (the round open now
 * included, so a missed hour heals itself). The question is chosen at lock (src/scheduler/lock.ts).
 * Returns the IDs created.
 */
export async function createRoundsAhead(env: Pick<Env, 'DB'>, t: number): Promise<string[]> {
  const created: string[] = [];
  for (const slot of slotsAhead(t)) {
    const id = await insertDailyRound(env.DB, slot);
    if (id) created.push(id);
  }
  return created;
}
