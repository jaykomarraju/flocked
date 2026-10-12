// SQL pieces the identity and limits code shares: a batch guard, `audit_log` rows, and the
// "round not final" and "live ticket" conditions (spec "Identity and personhood", "Data model").
import { TERMINAL_MODE_STATUSES, gameDayOf, newUlid } from '@flocked/shared';
import { TICKET_REISSUE_GRACE_SEC } from '../stakes/cap.js';

/**
 * A statement that aborts its D1 batch (one transaction) when `condition` holds at that point of
 * the batch: it inserts a `limits` row that breaks `limits_pending_cap_pair`, and nothing else
 * ever writes such a row. `condition` is SQL over the statement's own `?N` parameters.
 */
export function abortIf(
  db: D1Database,
  condition: string,
  ...binds: unknown[]
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO limits (user_id, pending_cap, pending_cap_effective_at) ' +
        `SELECT 'batch-guard', 0, NULL WHERE ${condition}`,
    )
    .bind(...binds);
}

/** True for the error an `abortIf` guard raises (the batch rolled back). */
export function isGuardAbort(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('CHECK constraint failed: limits_pending_cap_pair');
}

export interface AuditRow {
  actor: 'user' | 'admin' | 'system';
  actorUserId: string | null;
  action: string;
  target: string;
  data: Record<string, unknown>;
  now: number;
}

/** One `audit_log` row (spec "Data model": every admin action, merge and settlement). */
export function auditStatement(db: D1Database, row: AuditRow): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO audit_log (id, actor, actor_user_id, action, target, data_json, created_at) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    )
    .bind(
      newUlid(row.now),
      row.actor,
      row.actorUserId,
      row.action,
      row.target,
      JSON.stringify(row.data),
      row.now,
    );
}

const TERMINAL = TERMINAL_MODE_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * SQL: user `userSql` has an entry in a round whose mode is not final yet (settled, refunded or
 * voided). Spec: merges and deletion wait for these.
 */
export function hasOpenEntrySql(userSql: string): string {
  return (
    'EXISTS (SELECT 1 FROM entries e JOIN round_modes rm ON rm.round_id = e.round_id AND rm.mode = e.mode ' +
    `WHERE e.user_id = ${userSql} AND rm.status NOT IN (${TERMINAL}))`
  );
}

/**
 * SQL: user `userSql` holds a live Stakes ticket (unused, expiry + 30 s not passed at `nowSecSql`;
 * src/stakes/cap.ts). An entry may still land from it.
 */
export function hasLiveTicketSql(userSql: string, nowSecSql: string): string {
  return (
    'EXISTS (SELECT 1 FROM stakes_tickets st WHERE st.user_id = ' +
    `${userSql} AND st.used_tx IS NULL AND st.expiry + ${TICKET_REISSUE_GRACE_SEC} > ${nowSecSql})`
  );
}

/**
 * Re-points the Stakes tickets of user `from` for the current and later game days to user `to`
 * (SQL over `binds`), so the daily cap and the one-live-ticket rule, both counted by
 * `stakes_tickets.user_id` (src/stakes/), see one person (W6-Z carry-over). Earlier game days count
 * against no cap. `where` adds a condition the move needs.
 */
export function carryTicketsStatement(
  db: D1Database,
  sql: { from: string; to: string; where?: string },
  nowMs: number,
  ...binds: unknown[]
): D1PreparedStatement {
  const today = gameDayOf(Math.floor(nowMs / 1000));
  const n = binds.length + 1;
  return db
    .prepare(
      `UPDATE stakes_tickets SET user_id = ${sql.to} WHERE user_id = ${sql.from} ` +
        `AND game_day >= ?${n}${sql.where ? ` AND ${sql.where}` : ''}`,
    )
    .bind(...binds, today);
}
