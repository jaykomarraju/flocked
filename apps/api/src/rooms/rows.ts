// Room rows (D1 `rooms`, `room_members`) and the wire shapes built from them (spec "Profiles,
// leaderboards and rooms" › Rooms; packages/shared/src/api/rooms.ts).
//
// A room is visible to its members only: an unknown room, a closed one (its owner deleted their
// account and no other member remained; decision B5) and a room the caller isn't a member of all
// answer the same 404, so a non-member can't tell whether a room exists.
//
// Members are served as public users the way questions serve their authors (src/questions/rows.ts
// `questionAuthor`): a deleted account is already anonymized in D1, and a merged one keeps its old
// profile there; both are served as the opaque ID alone.
import { RoomSchema, type PublicUser, type Room, type RoomRole } from '@flocked/shared';
import { HttpError } from '../lib/errors.js';
import { questionAuthor } from '../questions/rows.js';

/** One `rooms` row with its member count (the cap's: members whose account isn't deleted). */
export interface RoomRow {
  id: string;
  name: string;
  owner_user_id: string;
  invite_code: string;
  question_source: string;
  created_at: number;
  closed_at: number | null;
  member_count: number;
}

/**
 * `SELECT` of a room (alias `r`) and its member count; append `WHERE …`. The count is the cap's
 * (`ROOM_MAX_MEMBERS` members whose account isn't deleted, as src/rooms/join.ts counts them), which
 * is the count the room view serves (spec "Profiles, leaderboards and rooms" › Rooms; owner decision,
 * Oct 16, 2026).
 */
export const ROOM_SELECT =
  'SELECT r.id, r.name, r.owner_user_id, r.invite_code, r.question_source, r.created_at, ' +
  'r.closed_at, (SELECT COUNT(*) FROM room_members c JOIN users cu ON cu.id = c.user_id ' +
  "WHERE c.room_id = r.id AND cu.status <> 'deleted') AS member_count " +
  'FROM rooms r';

/** The wire `Room`, parsed (a bad stored value fails loudly instead of being served). */
export function roomView(row: RoomRow): Room {
  return RoomSchema.parse({
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    inviteCode: row.invite_code,
    questionSource: row.question_source,
    memberCount: row.member_count,
    createdAt: row.created_at,
  });
}

/** The 404 for a room the caller may not see (unknown, closed, or not a member). */
export function noSuchRoom(): HttpError {
  return new HttpError('not_found', 'No such room');
}

/** An open room by ID, or null. */
export async function openRoom(db: D1Database, roomId: string): Promise<RoomRow | null> {
  return db
    .prepare(`${ROOM_SELECT} WHERE r.id = ?1 AND r.closed_at IS NULL`)
    .bind(roomId)
    .first<RoomRow>();
}

/** An open room the user is a member of, with their role; else the 404 above. */
export async function memberRoom(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<RoomRow & { role: RoomRole }> {
  const row = await db
    .prepare(
      `${ROOM_SELECT} JOIN room_members m ON m.room_id = r.id AND m.user_id = ?2 ` +
        'WHERE r.id = ?1 AND r.closed_at IS NULL',
    )
    .bind(roomId, userId)
    .first<RoomRow & { role: RoomRole }>();
  if (!row) throw noSuchRoom();
  return row;
}

/** A user's columns as the room reads select them (alias `u`, joined on the user ID). */
export interface UserColumns {
  user_id: string;
  u_status: string | null;
  u_handle: string | null;
  u_display_name: string | null;
  u_avatar_url: string | null;
}

export const USER_COLUMNS =
  'u.status AS u_status, u.handle AS u_handle, u.display_name AS u_display_name, ' +
  'u.avatar_url AS u_avatar_url';

/** A member as served: the public profile, or the opaque ID alone for a deleted or merged account. */
export function publicMember(r: UserColumns): PublicUser {
  return (
    questionAuthor({
      author_user_id: r.user_id,
      a_status: r.u_status,
      a_handle: r.u_handle,
      a_display_name: r.u_display_name,
      a_avatar_url: r.u_avatar_url,
    }) ?? { id: r.user_id, handle: null, displayName: null, avatarUrl: null }
  );
}

/** Statuses whose accounts are listed on the room leaderboard (deleted and merged ones are not). */
export const LISTED_STATUSES: ReadonlySet<string> = new Set(['active', 'suspended']);
