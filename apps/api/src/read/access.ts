// Who may read a round (spec "API" › Reveal gating): daily rounds are public; room rounds, their
// WebSockets, cards and bundles are for the room's members only. A round is public only once its
// question is locked: before that its question and config can still change.
//
// Answers, so a room round stays invisible to everyone outside the room:
//   - no such round, or not locked yet: 404 `not_found`;
//   - a room round without a session: 401 `unauthorized`;
//   - a room round, signed in but not a member: 404 `not_found` (as if it didn't exist).
import type { RoundKind } from '@flocked/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, SessionUser } from '../lib/auth-context.js';
import { HttpError } from '../lib/errors.js';

export interface RoundAccess {
  id: string;
  kind: RoundKind;
  roomId: string | null;
  /** True for room rounds: responses must never reach a shared cache. */
  membersOnly: boolean;
}

/** True when `userId` is a member (or the owner) of `roomId`. */
export async function isRoomMember(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM room_members WHERE room_id = ?1 AND user_id = ?2')
    .bind(roomId, userId)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * The round if `user` may read it, else the HttpError above. Every gated route calls this before
 * reading anything else about the round.
 */
export async function roundAccess(
  db: D1Database,
  roundId: string,
  user: SessionUser | undefined,
): Promise<RoundAccess> {
  const row = await db
    .prepare('SELECT id, kind, room_id FROM rounds WHERE id = ?1 AND locked_at IS NOT NULL')
    .bind(roundId)
    .first<{ id: string; kind: RoundKind; room_id: string | null }>();
  if (!row) throw new HttpError('not_found', 'No such round');
  if (row.kind === 'daily' || row.room_id === null) {
    return { id: row.id, kind: row.kind, roomId: null, membersOnly: false };
  }
  if (!user) throw new HttpError('unauthorized', 'Sign in to see this room round');
  if (!(await isRoomMember(db, row.room_id, user.id))) {
    throw new HttpError('not_found', 'No such round');
  }
  return { id: row.id, kind: row.kind, roomId: row.room_id, membersOnly: true };
}

/** `roundAccess` for the `:id` path parameter, as middleware (routes whose handler is elsewhere). */
export const requireRoundAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  await roundAccess(c.env.DB, c.req.param('id') ?? '', c.get('user'));
  await next();
};

/** The round for the request's `:id`, checked. */
export function accessFor(c: Context<AppEnv>, roundId: string): Promise<RoundAccess> {
  return roundAccess(c.env.DB, roundId, c.get('user'));
}
