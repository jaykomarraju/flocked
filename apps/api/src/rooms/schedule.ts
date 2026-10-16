// Room rounds (spec "Profiles, leaderboards and rooms" › Rooms: room rounds use the daily schedule,
// each its own `rounds` row with kind = room and one RoundDO). The scheduler's hourly job inserts one
// room round per open room per daily slot ahead (src/scheduler/create.ts), and a new room gets its
// rounds at creation (POST /rooms), so the owner of a custom room can set the next one's question at
// once. Only slots whose question lock (opensAt − LOCK_LEAD_MS) is still ahead get a room round: a
// round created past its lock could never take a question. The question is chosen at lock
// (src/scheduler/lock.ts): a mirror room's round takes the same slot's daily question; a custom
// room's round takes the owner's (POST /rooms/:id/questions), and closes without a round if there is
// none by then. Idempotent: `rounds_room_slot` (migration 0019) keeps one room round per room and slot.
import { newUlid } from '@flocked/shared';
import { slotsAhead, type DailySlot } from '../scheduler/create.js';
import { LOCK_LEAD_MS } from '../scheduler/lock.js';

/** Inserts the room's round for `slot` unless one exists; returns the new round's ID, or null. */
export async function insertRoomRound(
  db: D1Database,
  roomId: string,
  slot: DailySlot,
): Promise<string | null> {
  const id = newUlid();
  const res = await db
    .prepare(
      `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, status)
       SELECT ?1, 'room', ?2, NULL, ?3, ?4, 'scheduled'
       WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ?2 AND closed_at IS NULL)
       ON CONFLICT DO NOTHING`,
    )
    .bind(id, roomId, slot.opensAt, slot.closesAt)
    .run();
  return res.meta.changes === 1 ? id : null;
}

/** The daily slots ahead of `t` whose question lock hasn't passed (the ones a room round can take). */
export function roomSlotsAhead(t: number): DailySlot[] {
  return slotsAhead(t).filter((s) => s.opensAt - LOCK_LEAD_MS > t);
}

/**
 * Inserts the room's missing rounds for every slot ahead of `t` whose lock hasn't passed (none for a
 * closed room). Returns the IDs created.
 */
export async function insertRoomRoundsAhead(
  db: D1Database,
  roomId: string,
  t: number,
): Promise<string[]> {
  const created: string[] = [];
  for (const slot of roomSlotsAhead(t)) {
    const id = await insertRoomRound(db, roomId, slot);
    if (id) created.push(id);
  }
  return created;
}
