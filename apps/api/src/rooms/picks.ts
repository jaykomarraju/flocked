// Member picks after the reveal (spec "Profiles, leaderboards and rooms" › Rooms: "The room page
// shows the room split, member picks after the reveal"; "API" › Reveal gating).
//
// The picks of the room's latest round whose Free mode has `revealed_at` set: each entrant with the
// option their entry decrypted to, or null for an invalid (VOID) entry. Settlement writes the
// decrypted options (`entries.option_index`, `valid`) before it sets `revealed_at`
// (src/settlement/apply/free.ts steps 2 and 3), so the entries are read only through a round found
// by `revealed_at`: an unrevealed round's options are never read, and before the first reveal there
// are no picks (null). Room rounds take entries from members only (src/read/access.ts), so every
// entrant is (or, before a merge moved their membership, was) a member.
import type { RoomPicks } from '@flocked/shared';
import { USER_COLUMNS, publicMember, type UserColumns } from './rows.js';

interface PickRow extends UserColumns {
  valid: number | null;
  option_index: number | null;
}

/** The latest revealed Free room round of `roomId`, or null. */
async function latestRevealed(db: D1Database, roomId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT r.id FROM rounds r
       JOIN round_modes m ON m.round_id = r.id AND m.mode = 'free' AND m.revealed_at IS NOT NULL
       WHERE r.kind = 'room' AND r.room_id = ?1
       ORDER BY r.closes_at DESC, r.id DESC LIMIT 1`,
    )
    .bind(roomId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function memberPicks(db: D1Database, roomId: string): Promise<RoomPicks | null> {
  const roundId = await latestRevealed(db, roomId);
  if (roundId === null) return null;
  const { results } = await db
    .prepare(
      `SELECT e.user_id, e.valid, e.option_index, ${USER_COLUMNS}
       FROM entries e
       JOIN round_modes m ON m.round_id = e.round_id AND m.mode = 'free' AND m.revealed_at IS NOT NULL
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.round_id = ?1 AND e.mode = 'free' AND e.user_id IS NOT NULL
       ORDER BY e.receipt_seq`,
    )
    .bind(roundId)
    .all<PickRow>();
  return {
    roundId,
    picks: results.map((r) => ({
      user: publicMember(r),
      option:
        r.valid === 1 && (r.option_index === 0 || r.option_index === 1) ? r.option_index : null,
    })),
  };
}
