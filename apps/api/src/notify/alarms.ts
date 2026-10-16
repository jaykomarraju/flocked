// Recipients of the RoundDO's timed notifications (spec "Notifications"; src/rounds/hooks.ts calls
// `roundNotifications`). Daily rounds only: room rounds send no notifications. Each list holds the
// accounts that can be reached on the events' channels (a web push subscription or an enabled
// Farcaster token) and are not self-excluded now:
//   * `question_live` at opensAt: those with no entry in the daily round that just closed (it closes
//     at this round's opensAt), whose `outcome` already said the next question is live;
//   * `closing_soon` 60 min before close: those not yet entered in this round;
//   * `streak_at_risk` 3 h before close: those not yet entered, with a stray streak ≥ 3 in either mode
//     and the event turned on (it is off by default).
// Keys are `{event}:{roundId}:{userId}`, so an alarm that fires twice after an eviction enqueues the
// same keys and the consumer sends each once. The consumer still applies prefs and the exclusion
// rule at send time.
import { gameDayOf, type NotifyMessage } from '@flocked/shared';
import type { Env } from '../env.js';
import { excludedSql } from '../limits/rules.js';
import type { HookRound, RoundNotifyEvent } from '../rounds/hooks.js';

/** The stray streak at which `streak_at_risk` applies. */
export const STREAK_AT_RISK_MIN = 3;

const REACHABLE = `
  SELECT user_id FROM push_subscriptions
  UNION
  SELECT i.user_id FROM farcaster_notification_tokens t
  JOIN identities i ON i.provider = 'farcaster' AND i.external_id = CAST(t.fid AS TEXT)
  WHERE t.enabled = 1`;

/** Accounts reachable on push channels, not deleted, merged or self-excluded at ?1. */
const BASE = `
  WITH reachable AS (${REACHABLE})
  SELECT u.id AS user_id%COLUMNS% FROM users u JOIN reachable r ON r.user_id = u.id
  WHERE u.status IN ('active', 'suspended') AND NOT ${excludedSql('u.id', '?1')}`;

const notEnteredIn = (roundSql: string) =>
  `NOT EXISTS (SELECT 1 FROM entries e WHERE e.round_id = ${roundSql} AND e.user_id = u.id)`;

/** The `notify` messages for one RoundDO notification event at `t`. */
export async function roundNotifications(
  env: Pick<Env, 'DB'>,
  event: RoundNotifyEvent,
  round: HookRound,
  t: number,
): Promise<NotifyMessage[]> {
  if (round.kind !== 'daily') return [];
  const db = env.DB;
  const { roundId } = round;
  const closesAt = Math.floor(round.closesAt / 1000);
  const key = (userId: string) => `${event}:${roundId}:${userId}`;

  if (event === 'question_live') {
    const gameDay = gameDayOf(closesAt);
    const { results } = await db
      .prepare(
        `${BASE.replace('%COLUMNS%', '')}
         AND NOT EXISTS (SELECT 1 FROM entries e JOIN rounds p ON p.id = e.round_id
                         WHERE p.kind = 'daily' AND p.closes_at = ?2 AND p.id <> ?3
                           AND e.user_id = u.id)`,
      )
      .bind(t, round.opensAt, roundId)
      .all<{ user_id: string }>();
    return results.map(({ user_id }) => ({
      event,
      userId: user_id,
      dedupeKey: key(user_id),
      payload: { roundId, gameDay },
    }));
  }

  if (event === 'closing_soon') {
    const { results } = await db
      .prepare(`${BASE.replace('%COLUMNS%', '')} AND ${notEnteredIn('?2')}`)
      .bind(t, roundId)
      .all<{ user_id: string }>();
    return results.map(({ user_id }) => ({
      event,
      userId: user_id,
      dedupeKey: key(user_id),
      payload: { roundId, closesAt },
    }));
  }

  const { results } = await db
    .prepare(
      `${BASE.replace(
        '%COLUMNS%',
        ', (SELECT max(s.stray_streak) FROM user_stats s WHERE s.user_id = u.id) AS streak',
      )}
       AND ${notEnteredIn('?2')}
       AND EXISTS (SELECT 1 FROM notification_prefs p
                   WHERE p.user_id = u.id AND p.event = 'streak_at_risk' AND p.enabled = 1
                     AND p.channel IN ('farcaster', 'webpush'))
       AND (SELECT max(s.stray_streak) FROM user_stats s WHERE s.user_id = u.id) >= ?3`,
    )
    .bind(t, roundId, STREAK_AT_RISK_MIN)
    .all<{ user_id: string; streak: number }>();
  return results.map(({ user_id, streak }) => ({
    event: 'streak_at_risk',
    userId: user_id,
    dedupeKey: key(user_id),
    payload: { roundId, strayStreak: streak, closesAt },
  }));
}
