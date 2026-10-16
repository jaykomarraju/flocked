// POST /rooms/join `{inviteCode}` (spec "Profiles, leaderboards and rooms" › Rooms: max 50 members
// by default; 500 room points on joining).
//
// Answers: an unknown or closed room → 404 `not_found`; already a member → 200 with the room and no
// second grant; a full room (`ROOM_MAX_MEMBERS` members whose account isn't deleted) → 409
// `room_full`; a joiner whose account is no longer active (suspended, merged or deleted since the
// session was read) → 403 `account_suspended` (W8-F1 L3).
//
// One D1 batch: the membership, inserted only while the room is open, below the cap and the joiner's
// account active (all read inside the insert, so concurrent joins never exceed the cap, a racing
// account deletion that closes the room wins or loses as a whole, and a merge or deletion of the
// joiner committing first leaves no member behind); then the join grant (500, reason `room_grant`, ref =
// scope = the room ID), whose balance row and ledger row are written only when the membership row
// exists. The ledger insert does nothing on the ledger's unique key, and the balance moves only by
// the row this request inserted, so a member is credited once however often they join (spec "Data
// model" › Atomic points movements).
import {
  ROOM_MAX_MEMBERS,
  newUlid,
  type JoinRoomRequest,
  type JoinRoomResponse,
} from '@flocked/shared';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { POINTS } from '../points/index.js';
import { ROOM_SELECT, noSuchRoom, roomView, type RoomRow } from './rows.js';

// ?1 room, ?2 user, ?3 now, ?4 cap.
const INSERT_MEMBER =
  'INSERT INTO room_members (room_id, user_id, role, joined_at) ' +
  "SELECT ?1, ?2, 'member', ?3 " +
  'WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ?1 AND closed_at IS NULL) ' +
  "AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND status = 'active') " +
  'AND (SELECT COUNT(*) FROM room_members c JOIN users cu ON cu.id = c.user_id ' +
  "WHERE c.room_id = ?1 AND cu.status <> 'deleted') < ?4 " +
  'ON CONFLICT DO NOTHING';

const IS_MEMBER = 'EXISTS (SELECT 1 FROM room_members WHERE room_id = ?2 AND user_id = ?1)';

// ?1 user, ?2 room (the scope), ?3 now.
const ENSURE_BALANCE_ROW =
  'INSERT INTO point_balances (user_id, scope, balance, updated_at) ' +
  `SELECT ?1, ?2, 0, ?3 WHERE ${IS_MEMBER} ON CONFLICT DO NOTHING`;
// ?1 user, ?2 room, ?3 now, ?4 ledger ID, ?5 amount.
const INSERT_LEDGER =
  'INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) ' +
  `SELECT ?4, ?1, ?2, ?5, 'room_grant', ?2, ?3 WHERE ${IS_MEMBER} ON CONFLICT DO NOTHING`;
const CREDIT_IF_LEDGER_ROW =
  'UPDATE point_balances SET balance = balance + ?5, updated_at = ?3 ' +
  'WHERE user_id = ?1 AND scope = ?2 AND EXISTS (SELECT 1 FROM points_ledger WHERE id = ?4)';

async function roomByCode(db: D1Database, code: string): Promise<RoomRow | null> {
  return db.prepare(`${ROOM_SELECT} WHERE r.invite_code = ?1`).bind(code).first<RoomRow>();
}

async function isMember(db: D1Database, roomId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM room_members WHERE room_id = ?1 AND user_id = ?2')
    .bind(roomId, userId)
    .first<{ ok: number }>();
  return row !== null;
}

/** The room as served now (its member count after the join). */
async function served(db: D1Database, roomId: string): Promise<JoinRoomResponse> {
  const row = await db.prepare(`${ROOM_SELECT} WHERE r.id = ?1`).bind(roomId).first<RoomRow>();
  if (!row) throw noSuchRoom();
  return { room: roomView(row) };
}

export async function joinRoom(
  db: D1Database,
  userId: string,
  body: JoinRoomRequest,
  t: number,
): Promise<JoinRoomResponse> {
  const room = await roomByCode(db, body.inviteCode);
  if (!room || room.closed_at !== null) throw noSuchRoom();
  if (await isMember(db, room.id, userId)) return served(db, room.id);

  const ledgerId = newUlid(t);
  const grant = [userId, room.id, t, ledgerId, POINTS.roomJoinGrant] as const;
  const [member, , ledger] = await db.batch([
    db.prepare(INSERT_MEMBER).bind(room.id, userId, t, ROOM_MAX_MEMBERS),
    db.prepare(ENSURE_BALANCE_ROW).bind(...grant.slice(0, 3)),
    db.prepare(INSERT_LEDGER).bind(...grant),
    db.prepare(CREDIT_IF_LEDGER_ROW).bind(...grant),
  ]);
  if ((member?.meta.changes ?? 0) === 1) {
    log.info('room_joined', { roomId: room.id, granted: (ledger?.meta.changes ?? 0) === 1 });
    return served(db, room.id);
  }
  // Nothing inserted: a concurrent join of ours, the room closed meanwhile, our account no longer
  // active, or the room is full.
  if (await isMember(db, room.id, userId)) return served(db, room.id);
  const joiner = await db
    .prepare('SELECT status FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ status: string }>();
  if (joiner?.status !== 'active') {
    throw new HttpError('account_suspended', 'This account can’t join rooms');
  }
  const now = await db
    .prepare('SELECT closed_at FROM rooms WHERE id = ?1')
    .bind(room.id)
    .first<{ closed_at: number | null }>();
  if (!now || now.closed_at !== null) throw noSuchRoom();
  throw new HttpError('room_full', `This room is full (${ROOM_MAX_MEMBERS} members)`);
}
