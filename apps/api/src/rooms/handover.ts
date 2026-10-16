// Rooms of a deleted owner (spec "Identity and personhood" › Account deletion: "Rooms the user owns
// pass to the oldest remaining member by join time. A room with no other member is closed."; decision
// B5, Oct 12, 2026). Statements for the DELETE /me batch (src/identity/delete.ts), SQL only and with
// no read before them, so a join that commits before the batch is a remaining member and one after it
// finds the room handed over or closed (src/rooms/join.ts inserts only into an open room).
//
// For each open room the user owns:
//   * another member remains (a `room_members` row of another user whose account isn't deleted): the
//     oldest by `joined_at` (then user ID) becomes the owner: `rooms.owner_user_id`, their role
//     `owner`, and the deleted user's role `member`;
//   * else the room closes (`closed_at`), and its room rounds that are still unlocked and scheduled
//     close without a round (status `closed`, as a custom room round without a question does at its
//     lock); locked rounds play out as they are.
// The deleted user's memberships stay, with the anonymized account. Run them after the batch has set
// the user's status to `deleted`.
//
// Binds: ?1 the deleted user, ?2 now (epoch ms).

/** SQL: the successor in the room `roomSql`, or NULL when no other member remains. */
const successor = (roomSql: string) =>
  '(SELECT s.user_id FROM room_members s JOIN users su ON su.id = s.user_id ' +
  `WHERE s.room_id = ${roomSql} AND s.user_id <> ?1 AND su.status <> 'deleted' ` +
  'ORDER BY s.joined_at, s.user_id LIMIT 1)';

/** SQL: the open rooms the user still owns. */
const OWNED = 'SELECT o.id FROM rooms o WHERE o.owner_user_id = ?1 AND o.closed_at IS NULL';

export function ownedRoomStatements(
  db: D1Database,
  userId: string,
  t: number,
): D1PreparedStatement[] {
  const s = (sql: string) => db.prepare(sql).bind(userId);
  return [
    // Hand-over: the successor's role, the deleted owner's role, then the room's owner.
    s(
      `UPDATE room_members SET role = 'owner' WHERE room_id IN (${OWNED}) ` +
        `AND user_id = ${successor('room_members.room_id')}`,
    ),
    s(
      "UPDATE room_members SET role = 'member' WHERE user_id = ?1 " +
        `AND room_id IN (${OWNED} AND ${successor('o.id')} IS NOT NULL)`,
    ),
    s(
      `UPDATE rooms SET owner_user_id = ${successor('rooms.id')} ` +
        `WHERE owner_user_id = ?1 AND closed_at IS NULL AND ${successor('rooms.id')} IS NOT NULL`,
    ),
    // No one remains: what the user still owns closes, with its unlocked room rounds.
    s(
      "UPDATE rounds SET status = 'closed' WHERE kind = 'room' AND locked_at IS NULL " +
        `AND status = 'scheduled' AND room_id IN (${OWNED})`,
    ),
    db
      .prepare('UPDATE rooms SET closed_at = ?2 WHERE owner_user_id = ?1 AND closed_at IS NULL')
      .bind(userId, t),
  ];
}
