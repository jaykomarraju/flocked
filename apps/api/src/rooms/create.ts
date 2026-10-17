// POST /rooms (spec "Profiles, leaderboards and rooms" › Rooms: any user creates a room and shares
// an invite link; the owner gets the 500 joining room points at creation).
//
// One D1 batch: the room (a fresh random invite code), the owner's `room_members` row (role owner),
// and the join grant as a points movement (`grantMovement`, reason `room_grant`, ref = scope = the
// room ID), so the balance row and its ledger row commit with the room or not at all (spec "Data
// model" › Atomic points movements). An invite code that collides with an existing one fails the
// unique index `rooms_invite_code`, which rolls the whole batch back; it is retried with a new code.
// The room is inserted only while the owner's account is active and owns fewer than ROOM_MAX_OWNED
// open rooms, both read inside the insert (W8-F1 H1, L3: a `DELETE /me` or another `POST /rooms`
// committing first can't be raced); the owner's membership row takes its user ID from the inserted
// room, so a refused insert fails that row's NOT NULL and rolls the whole batch back. Past the cap →
// 409 `conflict`; an owner no longer active → 403 `account_suspended`.
// Then the room's rounds for the daily slots ahead are inserted (src/rooms/schedule.ts), so the owner
// of a custom room can set the next round's question at once.
import {
  ROOM_MAX_OWNED,
  newUlid,
  type CreateRoomRequest,
  type CreateRoomResponse,
} from '@flocked/shared';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { POINTS, applyMovement, grantMovement } from '../points/index.js';
import { insertRoomRoundsAhead } from './schedule.js';
import { ROOM_SELECT, roomView, type RoomRow } from './rows.js';

/** Invite codes: base62, this long (about 59.5 bits), within `InviteCodeSchema`. */
export const INVITE_CODE_LENGTH = 10;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Bytes at or above this are dropped, so `b % 62` is uniform (248 = 4 × 62). */
const UNBIASED_BELOW = 248;

/** Attempts at a fresh invite code before giving up (a collision is already very unlikely). */
export const INVITE_CODE_ATTEMPTS = 5;

/** A random invite code from `crypto.getRandomValues`. */
export function newInviteCode(): string {
  let out = '';
  while (out.length < INVITE_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(2 * INVITE_CODE_LENGTH))) {
      if (b < UNBIASED_BELOW) out += ALPHABET[b % ALPHABET.length];
      if (out.length === INVITE_CODE_LENGTH) break;
    }
  }
  return out;
}

/** Replaceable in tests (an invite code collision). */
export const ROOM_DEPS = { inviteCode: newInviteCode };

const CONTROL = /\p{Cc}/u;

/** The name as stored: NFC and trimmed, non-empty plain text (or 400 `bad_request`). */
export function cleanRoomName(raw: string): string {
  const name = raw.normalize('NFC').trim();
  if (name.length === 0) throw new HttpError('bad_request', 'The room name is empty');
  if (CONTROL.test(name)) {
    throw new HttpError('bad_request', 'The room name must be plain text on one line');
  }
  return name;
}

function isInviteCodeConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('UNIQUE constraint failed: rooms.invite_code');
}

/** The owner's row failed its NOT NULL: the guarded room insert was refused (see the header). */
function isRefusedRoom(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('NOT NULL constraint failed: room_members.user_id');
}

const ownedOpenRooms = (db: D1Database, ownerId: string) =>
  db
    .prepare('SELECT COUNT(*) AS n FROM rooms WHERE owner_user_id = ?1 AND closed_at IS NULL')
    .bind(ownerId)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0);

function overOwnedCap(): HttpError {
  return new HttpError('conflict', `You can own at most ${ROOM_MAX_OWNED} open rooms`);
}

/** The batch for one attempt: room, owner membership and the join grant. */
async function insertRoom(
  db: D1Database,
  room: { id: string; name: string; ownerId: string; source: string; code: string; t: number },
): Promise<void> {
  const grant = grantMovement(db, {
    userId: room.ownerId,
    scope: room.id,
    amount: POINTS.roomJoinGrant,
    reason: 'room_grant',
    refId: room.id,
    now: room.t,
  });
  const head = [
    db
      .prepare(
        'INSERT INTO rooms (id, name, owner_user_id, invite_code, question_source, created_at) ' +
          'SELECT ?1, ?2, ?3, ?4, ?5, ?6 ' +
          "WHERE EXISTS (SELECT 1 FROM users WHERE id = ?3 AND status = 'active') " +
          'AND (SELECT COUNT(*) FROM rooms WHERE owner_user_id = ?3 AND closed_at IS NULL) < ?7',
      )
      .bind(room.id, room.name, room.ownerId, room.code, room.source, room.t, ROOM_MAX_OWNED),
    db
      .prepare(
        'INSERT INTO room_members (room_id, user_id, role, joined_at) ' +
          "VALUES (?1, (SELECT owner_user_id FROM rooms WHERE id = ?1), 'owner', ?2)",
      )
      .bind(room.id, room.t),
  ];
  const outcome = await applyMovement(db, {
    statements: [...head, ...grant.statements],
    ledgerIndexes: grant.ledgerIndexes.map((i) => i + head.length),
    ledgerIds: grant.ledgerIds,
  });
  // A new room's grant key is new: anything but `applied` is a bug, and the batch rolled back.
  if (outcome.status !== 'applied') {
    throw new Error(`room creation grant: unexpected outcome ${outcome.status}`);
  }
}

export async function createRoom(
  db: D1Database,
  ownerId: string,
  body: CreateRoomRequest,
  t: number,
): Promise<CreateRoomResponse> {
  const name = cleanRoomName(body.name);
  if ((await ownedOpenRooms(db, ownerId)) >= ROOM_MAX_OWNED) throw overOwnedCap();
  const id = newUlid(t);
  for (let attempt = 1; ; attempt++) {
    try {
      await insertRoom(db, {
        id,
        name,
        ownerId,
        source: body.questionSource,
        code: ROOM_DEPS.inviteCode(),
        t,
      });
      break;
    } catch (err) {
      if (isRefusedRoom(err)) {
        if ((await ownedOpenRooms(db, ownerId)) >= ROOM_MAX_OWNED) throw overOwnedCap();
        throw new HttpError('account_suspended', 'This account can’t create rooms');
      }
      if (!isInviteCodeConflict(err) || attempt >= INVITE_CODE_ATTEMPTS) throw err;
      log.warn('room_invite_code_collision', { roomId: id, attempt });
    }
  }
  const rounds = await insertRoomRoundsAhead(db, id, t);
  log.info('room_created', {
    roomId: id,
    questionSource: body.questionSource,
    rounds: rounds.length,
  });
  const row = await db.prepare(`${ROOM_SELECT} WHERE r.id = ?1`).bind(id).first<RoomRow>();
  if (!row) throw new Error(`room ${id} missing after its insert`);
  return { room: roomView(row) };
}
