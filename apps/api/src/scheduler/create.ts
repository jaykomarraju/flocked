// Daily round creation (spec "Round lifecycle" › Scheduling: a scheduler cron creates rounds in D1 48
// hours ahead; Timing: 21:00 to 21:00 America/New_York, 23 or 25 hours on DST change days).
// Idempotent: `rounds_daily_closes_at` (migration 0005) keeps one daily round per close time, so
// overlapping cron runs insert each game day once.
//
// W8-D: the same job inserts the room rounds ahead (spec "Profiles, leaderboards and rooms" › Rooms:
// room rounds use the daily schedule): one per open room (`closed_at IS NULL`) per daily slot whose
// question lock is still ahead (src/rooms/schedule.ts), idempotent through `rounds_room_slot`.
import { addGameDays, dailyClosesAt, dailyOpensAt, newUlid, openGameDayAt } from '@flocked/shared';
import type { Env } from '../env.js';
import { insertRoomRound, roomSlotsAhead } from '../rooms/schedule.js';
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

/** Open rooms read per page by the hourly job. */
export const ROOM_PAGE_SIZE = 200;

// Open rooms after ?1 (by ID) missing a room round for at least one of the slots in ?2 (a JSON array
// of close times): in steady state every room has its rounds and the page is empty.
const ROOMS_MISSING_ROUNDS =
  'SELECT r.id FROM rooms r WHERE r.closed_at IS NULL AND r.id > ?1 ' +
  "AND (SELECT COUNT(*) FROM rounds x WHERE x.kind = 'room' AND x.room_id = r.id " +
  'AND x.closes_at IN (SELECT value FROM json_each(?2))) < ?3 ' +
  'ORDER BY r.id LIMIT ?4';

/**
 * Inserts every open room's missing room rounds for the slots ahead of `t` whose lock hasn't passed,
 * paging through the rooms by ID. A closed room gets none (`insertRoomRound` checks it too, so a room
 * closed meanwhile is skipped). Returns the IDs created.
 */
export async function createRoomRoundsAhead(
  db: D1Database,
  t: number,
  pageSize = ROOM_PAGE_SIZE,
): Promise<string[]> {
  const slots = roomSlotsAhead(t);
  const created: string[] = [];
  if (slots.length === 0) return created;
  const closes = JSON.stringify(slots.map((s) => s.closesAt));
  let after = '';
  for (;;) {
    const { results } = await db
      .prepare(ROOMS_MISSING_ROUNDS)
      .bind(after, closes, slots.length, pageSize)
      .all<{ id: string }>();
    for (const room of results) {
      for (const slot of slots) {
        const id = await insertRoomRound(db, room.id, slot);
        if (id) created.push(id);
      }
    }
    const last = results[results.length - 1];
    if (!last || results.length < pageSize) return created;
    after = last.id;
  }
}

/**
 * The hourly job: creates every missing daily round that opens within 48 hours (the round open now
 * included, so a missed hour heals itself), then every open room's missing room rounds for the slots
 * whose lock is still ahead. The question is chosen at lock (src/scheduler/lock.ts). Returns the IDs
 * created (daily rounds first).
 */
export async function createRoundsAhead(env: Pick<Env, 'DB'>, t: number): Promise<string[]> {
  const created: string[] = [];
  for (const slot of slotsAhead(t)) {
    const id = await insertDailyRound(env.DB, slot);
    if (id) created.push(id);
  }
  created.push(...(await createRoomRoundsAhead(env.DB, t)));
  return created;
}
