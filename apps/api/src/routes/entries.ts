// Route module `entries`: Free entries and the caller's entries. POST /rounds/:id/entries is W3-B's
// (the RoundDO commit protocol answers it); GET /rounds/:id/me is W6-D's (src/read/me.ts), gated
// like every round read (room rounds for members only; nothing per option before the reveal).
//
// Before anything else about the round answers, a room round is invisible outside its room (spec
// "API" › Reveal gating; W6-F1 R10): a signed-in non-member gets the 404 an unknown round gets, never
// `not_member` or a Turnstile error that would say the round exists.
//
// Then, before the RoundDO, the route applies two anti-abuse rules (spec "Anti-abuse"; W4-A):
//   * Turnstile on the user's first Free entry of the game day (the New York date of the round's
//     `closesAt`): without a Free entry in any round closing that day, `turnstileToken` is required
//     and verified;
//   * for a daily round, the daily grant's wallet check (src/rounds/grant.ts
//     `recordPriorTransactions`), so the grant the RoundDO decides sees a wallet's onchain history.
import {
  CreateEntryRequestSchema,
  ERROR_STATUS,
  IdParamsSchema,
  addGameDays,
  dailyClosesAt,
  gameDayOf,
} from '@flocked/shared';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authDeps } from '../auth/deps.js';
import { clientIp, limitUser } from '../auth/rate-limit.js';
import { getUser, requireUser, type AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { validate } from '../lib/validate.js';
import { accessFor, isRoomMember } from '../read/access.js';
import { PRIVATE_CACHE_CONTROL } from '../read/cache.js';
import { readRoundMe } from '../read/me.js';
import { recordPriorTransactions } from '../rounds/grant.js';
import { stubEndpoints } from './stub.js';

const app = new Hono<AppEnv>();

interface RoundTimes {
  kind: string;
  room_id: string | null;
  closes_at: number;
}

/** True when the user has a Free entry in any round closing on `closesAt`'s New York date. */
export async function hasFreeEntryOnGameDay(
  db: D1Database,
  userId: string,
  closesAt: number,
): Promise<boolean> {
  const day = gameDayOf(Math.floor(closesAt / 1000));
  // Every round of that New York date closes strictly between the neighbouring days' 21:00 closes.
  const lo = dailyClosesAt(addGameDays(day, -1)) * 1000;
  const hi = dailyClosesAt(addGameDays(day, 1)) * 1000;
  const { results } = await db
    .prepare(
      "SELECT r.closes_at FROM entries e JOIN rounds r ON r.id = e.round_id WHERE e.user_id = ?1 AND e.mode = 'free' AND r.closes_at > ?2 AND r.closes_at < ?3",
    )
    .bind(userId, lo, hi)
    .all<{ closes_at: number }>();
  return results.some((r) => gameDayOf(Math.floor(r.closes_at / 1000)) === day);
}

/** Turnstile on the first Free entry of the game day (403 `turnstile_failed` otherwise). */
async function requireFirstEntryTurnstile(
  c: Context<AppEnv>,
  userId: string,
  round: RoundTimes,
  token: string | undefined,
): Promise<void> {
  if (await hasFreeEntryOnGameDay(c.env.DB, userId, round.closes_at)) return;
  if (!token) {
    throw new HttpError(
      'turnstile_failed',
      'Complete the human check to make your first pick today',
    );
  }
  const result = await verifyTurnstile(c.env, token, {
    remoteIp: clientIp(c),
    fetch: authDeps(c.env).turnstileFetch,
  });
  if (!result.success) {
    if (result.errorCodes.includes('missing-input-secret'))
      log.error('turnstile_secret_missing', {});
    throw new HttpError('turnstile_failed', 'The human check failed; try again');
  }
}

/**
 * POST /rounds/:id/entries: a sealed Free entry. The round's RoundDO checks, commits and signs it;
 * the response is the committed entry and its receipt. Rate limited per user (`entries`, 10/min).
 * Registered before the module's stubs, so it answers instead of the 501.
 */
app.post(
  '/rounds/:id/entries',
  requireUser,
  limitUser('entries'),
  validate('param', IdParamsSchema),
  validate('json', CreateEntryRequestSchema),
  async (c) => {
    const user = getUser(c);
    const { id: roundId } = c.req.valid('param');
    const body = c.req.valid('json');
    const round = await c.env.DB.prepare(
      'SELECT kind, room_id, closes_at FROM rounds WHERE id = ?1',
    )
      .bind(roundId)
      .first<RoundTimes>();
    // An unknown round falls through to the RoundDO, which answers not_found.
    if (round) {
      // A room round for a non-member: the RoundDO's answer for an unknown round, first.
      if (
        round.kind === 'room' &&
        (round.room_id === null || !(await isRoomMember(c.env.DB, round.room_id, user.id)))
      ) {
        throw new HttpError('not_found', 'no such round');
      }
      await requireFirstEntryTurnstile(c, user.id, round, body.turnstileToken);
      if (round.kind === 'daily') {
        await recordPriorTransactions(c.env, { userId: user.id, roundId, now: now(c.env) });
      }
    }
    const stub = c.env.ROUND.get(c.env.ROUND.idFromName(roundId));
    const result = await stub.enterFree({ roundId, userId: user.id, body });
    if (!result.ok) {
      throw new HttpError(
        result.code,
        result.message,
        ERROR_STATUS[result.code] as ContentfulStatusCode,
      );
    }
    return c.json(result.value, 201);
  },
);

/** GET /rounds/:id/me: the caller's entries, receipts, proofs, result, payouts and cards. */
app.get('/rounds/:id/me', requireUser, validate('param', IdParamsSchema), async (c) => {
  const { id } = c.req.valid('param');
  await accessFor(c, id);
  const body = await readRoundMe(c.env, id, getUser(c).id);
  return c.json(body, 200, { 'Cache-Control': PRIVATE_CACHE_CONTROL });
});

export const entries = stubEndpoints(app, 'entries');
