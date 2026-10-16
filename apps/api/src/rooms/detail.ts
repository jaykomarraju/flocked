// GET /rooms/:id (spec "API": room detail, members, current round, room leaderboard; "Profiles,
// leaderboards and rooms" › Rooms). Members only: the route answers 401 without a session, and this
// answers 404 for an unknown or closed room and for a non-member alike (src/rooms/rows.ts).
//
// A member's visit while a room round is open credits the room-round grant (+100 room points below
// 1,000; a skip is final for that round): `applyRoomGrant` (src/rounds/grant.ts), before the
// balances are read, so the response shows it.
//
// `currentRound` is the room round open now, else the latest one that has opened (locked, opensAt
// ≤ now), read with `readRound` (src/read/rounds.ts), which applies reveal gating per mode; null
// before the room's first round opens. The response is parsed with `RoomDetailResponseSchema`.
import { RoomDetailResponseSchema, type RoomDetailResponse } from '@flocked/shared';
import type { Env } from '../env.js';
import { readRound } from '../read/rounds.js';
import { applyRoomGrant } from '../rounds/grant.js';
import { roomLeaderboard, type MemberRow } from './leaderboard.js';
import { memberPicks } from './picks.js';
import { USER_COLUMNS, memberRoom, publicMember, roomView } from './rows.js';

/** The room round open now (locked, status open, opensAt ≤ t < closesAt), or null. */
async function openRoundId(db: D1Database, roomId: string, t: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM rounds
       WHERE kind = 'room' AND room_id = ?1 AND status = 'open' AND locked_at IS NOT NULL
         AND opens_at <= ?2 AND closes_at > ?2
       ORDER BY opens_at DESC, id DESC LIMIT 1`,
    )
    .bind(roomId, t)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** The latest room round that has opened (locked, opensAt ≤ t), or null. */
async function latestOpenedId(db: D1Database, roomId: string, t: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM rounds
       WHERE kind = 'room' AND room_id = ?1 AND locked_at IS NOT NULL AND opens_at <= ?2
       ORDER BY opens_at DESC, id DESC LIMIT 1`,
    )
    .bind(roomId, t)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Every member with their role, join time and room balance (0 without a balance row). */
async function members(db: D1Database, roomId: string): Promise<MemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.user_id, m.role, m.joined_at, COALESCE(b.balance, 0) AS balance, ${USER_COLUMNS}
       FROM room_members m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN point_balances b ON b.user_id = m.user_id AND b.scope = m.room_id
       WHERE m.room_id = ?1
       ORDER BY m.joined_at, m.user_id`,
    )
    .bind(roomId)
    .all<MemberRow>();
  return results;
}

export async function readRoomDetail(
  env: Env,
  roomId: string,
  userId: string,
  t: number,
): Promise<RoomDetailResponse> {
  const db = env.DB;
  const room = await memberRoom(db, roomId, userId);
  const open = await openRoundId(db, roomId, t);
  if (open) await applyRoomGrant(db, { userId, roomId, roundId: open, now: t });

  const currentId = open ?? (await latestOpenedId(db, roomId, t));
  const rows = await members(db, roomId);
  const [currentRound, picks, leaderboard] = await Promise.all([
    currentId ? readRound(env, currentId) : null,
    memberPicks(db, roomId),
    roomLeaderboard(db, roomId, rows, t),
  ]);
  return RoomDetailResponseSchema.parse({
    room: roomView(room),
    members: rows.map((m) => ({
      user: publicMember(m),
      role: m.role,
      joinedAt: m.joined_at,
      balance: String(m.balance),
    })),
    currentRound,
    leaderboard,
    memberPicks: picks,
  } satisfies RoomDetailResponse);
}
