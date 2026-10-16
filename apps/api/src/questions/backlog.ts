// The house backlog alert (spec "Question pipeline" › House questions: "The admin is also alerted
// when the backlog drops below 14"). The backlog is the questions with status `queued` and no author.
// Checked after a lock that used a house question (src/scheduler/lock.ts) and after an admin Assign.
// Below the minimum it writes an `audit_log` row (`schedule_gap`, target `house_backlog`) and raises
// ALERT_SCHEDULE_GAP (reason `house_backlog_low`), at most once per 24 hours: the row is written
// only when no other was in the last 24 hours, in one statement, so overlapping checks alert once
// and a backlog that stays low pages once a day.
import { newUlid } from '@flocked/shared';
import type { Env } from '../env.js';
import { raiseAlert } from '../lib/alert.js';
import { HOUR_MS } from '../rounds/schedule.js';

/** The spec's minimum house backlog. */
export const HOUSE_BACKLOG_MIN = 14;
/** A low backlog alerts again after this long. */
export const HOUSE_BACKLOG_ALERT_EVERY_MS = 24 * HOUR_MS;
/** The `audit_log.target` of backlog alerts. */
export const HOUSE_BACKLOG_TARGET = 'house_backlog';

export async function checkHouseBacklog(
  env: Pick<Env, 'DB' | 'ANALYTICS' | 'ENVIRONMENT'>,
  t: number,
): Promise<{ count: number; alerted: boolean }> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM questions WHERE status = 'queued' AND author_user_id IS NULL",
  ).first<{ n: number }>();
  const count = row?.n ?? 0;
  if (count >= HOUSE_BACKLOG_MIN) return { count, alerted: false };
  const data = { reason: 'house_backlog_low', count, min: HOUSE_BACKLOG_MIN };
  const res = await env.DB.prepare(
    `INSERT INTO audit_log (id, actor, actor_user_id, action, target, data_json, created_at)
     SELECT ?1, 'system', NULL, 'schedule_gap', ?2, ?3, ?4
     WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'schedule_gap' AND target = ?2
                       AND created_at > ?5)`,
  )
    .bind(
      newUlid(t),
      HOUSE_BACKLOG_TARGET,
      JSON.stringify(data),
      t,
      t - HOUSE_BACKLOG_ALERT_EVERY_MS,
    )
    .run();
  if (res.meta.changes !== 1) return { count, alerted: false };
  raiseAlert(env, 'ALERT_SCHEDULE_GAP', { target: HOUSE_BACKLOG_TARGET, ...data });
  return { count, alerted: true };
}
