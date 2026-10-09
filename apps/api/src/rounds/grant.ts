// The daily grant (spec "Modes: Free and Stakes": +100 points per daily round, credited on the
// user's first visit or entry after the round opens, only if the balance is below 1,000; ledger ref
// = round ID). A grant skipped because the balance is ≥ 1,000 is final for that game day and writes
// no ledger row (Decision log, Oct 8, 2026), so the skip is recorded in `daily_grant_skips`
// (migrations/0003_round_do.sql). There is one daily round per game day, so (user, round) is the
// game-day key.
//
// The decision is made inside the batch, like `grantMovement` with `onlyIfBalanceBelow`, but it
// also honours a recorded skip. Exported for the visit path (whoever implements the first-visit
// grant must use this, not `grantMovement`, or a skipped grant could be credited later that day).
import { newUlid } from '@flocked/shared';
import {
  GLOBAL_SCOPE,
  POINTS,
  applyMovement,
  type MovementOutcome,
  type PointsMovement,
} from '../points/index.js';

const ENSURE_BALANCE_ROW =
  'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, 0, ?3) ' +
  'ON CONFLICT DO NOTHING';
// Records the skip only when the balance is at or above the threshold and no grant was made.
const RECORD_SKIP =
  'INSERT INTO daily_grant_skips (user_id, round_id, balance, skipped_at) ' +
  'SELECT ?1, ?3, b.balance, ?4 FROM point_balances b ' +
  'WHERE b.user_id = ?1 AND b.scope = ?2 AND b.balance >= ?5 ' +
  "AND NOT EXISTS (SELECT 1 FROM points_ledger WHERE user_id = ?1 AND scope = ?2 AND reason = 'daily_grant' AND ref_id = ?3) " +
  'ON CONFLICT DO NOTHING';
// A retried grant that already committed fails the ledger's unique key (`duplicate`) or, if the
// balance has since reached the threshold, inserts nothing (`skipped`): it never credits twice.
const INSERT_LEDGER =
  'INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) ' +
  "SELECT ?6, ?1, ?2, ?7, 'daily_grant', ?3, ?4 " +
  'WHERE (SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = ?2) < ?5 ' +
  'AND NOT EXISTS (SELECT 1 FROM daily_grant_skips WHERE user_id = ?1 AND round_id = ?3)';
const CREDIT_IF_LEDGER_ROW =
  'UPDATE point_balances SET balance = balance + ?7, updated_at = ?4 ' +
  'WHERE user_id = ?1 AND scope = ?2 AND EXISTS (SELECT 1 FROM points_ledger WHERE id = ?6)';

/** The batch for one daily-round grant decision. */
export function dailyGrantMovement(
  db: D1Database,
  i: { userId: string; roundId: string; now: number; ledgerId?: string },
): PointsMovement {
  const id = i.ledgerId ?? newUlid(i.now);
  const args = [
    i.userId,
    GLOBAL_SCOPE,
    i.roundId,
    i.now,
    POINTS.roundGrantBelow,
    id,
    POINTS.roundGrant,
  ];
  const bind = (sql: string, n: number) => db.prepare(sql).bind(...args.slice(0, n));
  return {
    statements: [
      db.prepare(ENSURE_BALANCE_ROW).bind(i.userId, GLOBAL_SCOPE, i.now),
      bind(RECORD_SKIP, 5),
      bind(INSERT_LEDGER, 7),
      bind(CREDIT_IF_LEDGER_ROW, 7),
    ],
    ledgerIndexes: [2],
    ledgerIds: [id],
  };
}

/**
 * Grants or skips the daily grant for (user, daily round). `applied` = credited now; `skipped` =
 * not credited (balance ≥ 1,000 now or earlier this game day); `duplicate` = credited before.
 * Insufficient balance cannot happen (nothing is debited).
 */
export function applyDailyGrant(
  db: D1Database,
  i: { userId: string; roundId: string; now: number },
): Promise<MovementOutcome> {
  return applyMovement(db, dailyGrantMovement(db, i));
}
