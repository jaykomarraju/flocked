// The nightly points reconciliation (spec "Data model" › Atomic points movements; cron 08:15 UTC in
// src/cron.ts): every (user, scope) balance must equal the sum of its ledger rows. Each movement is
// one D1 transaction, so a mismatch means something wrote around the ledger. It pages as a
// reconciliation mismatch (ALERT_SETTLEMENT_FAILED, "Non-functional requirements" › Alerts) and
// changes nothing: the fix is an admin adjustment with an audit_log row (W11-A).
//
// The check runs in pages of users (keyset on user_id), so each query reads a bounded slice of both
// tables through their user_id-leading indexes. Ledger rows without a balance row count too.
import type { Env } from '../env.js';
import { raiseAlert } from '../lib/alert.js';
import { log } from '../lib/log.js';
import type { BalanceMismatch } from '../points/index.js';

/** Users per page. */
export const RECONCILE_PAGE = 500;
/** Mismatches listed in the alert and the log (the count is always complete). */
const SAMPLE = 20;

export interface ReconcileReport {
  users: number;
  pages: number;
  mismatches: BalanceMismatch[];
}

/** The (user, scope) pairs in (lo, hi] whose balance and ledger sum differ; hi null is unbounded. */
async function mismatchesIn(
  db: D1Database,
  lo: string,
  hi: string | null,
): Promise<BalanceMismatch[]> {
  const range = hi === null ? 'user_id > ?1' : 'user_id > ?1 AND user_id <= ?2';
  const { results } = await db
    .prepare(
      `WITH keys AS (
         SELECT user_id, scope FROM point_balances WHERE ${range}
         UNION
         SELECT DISTINCT user_id, scope FROM points_ledger WHERE ${range}
       ),
       sums AS (
         SELECT user_id, scope, SUM(delta) AS total FROM points_ledger WHERE ${range}
         GROUP BY user_id, scope
       )
       SELECT k.user_id AS userId, k.scope AS scope, COALESCE(b.balance, 0) AS balance,
              COALESCE(s.total, 0) AS ledgerSum
       FROM keys k
       LEFT JOIN point_balances b ON b.user_id = k.user_id AND b.scope = k.scope
       LEFT JOIN sums s ON s.user_id = k.user_id AND s.scope = k.scope
       WHERE COALESCE(b.balance, 0) <> COALESCE(s.total, 0)
       ORDER BY k.user_id, k.scope`,
    )
    .bind(...(hi === null ? [lo] : [lo, hi]))
    .all<BalanceMismatch>();
  return results;
}

/** Compares every balance with its ledger; alerts once per run on any mismatch. */
export async function reconcilePoints(
  env: Pick<Env, 'DB' | 'ANALYTICS' | 'ENVIRONMENT'>,
  opts: { pageSize?: number } = {},
): Promise<ReconcileReport> {
  const db = env.DB;
  const pageSize = opts.pageSize ?? RECONCILE_PAGE;
  const mismatches: BalanceMismatch[] = [];
  let users = 0;
  let pages = 0;
  let after = '';
  for (;;) {
    // The page's users come from point_balances; ledger-only users in the same range come along.
    const { results } = await db
      .prepare(
        'SELECT user_id FROM point_balances WHERE user_id > ?1 GROUP BY user_id ORDER BY user_id LIMIT ?2',
      )
      .bind(after, pageSize)
      .all<{ user_id: string }>();
    const last = results[results.length - 1]?.user_id ?? null;
    const full = results.length === pageSize;
    // The last page is open-ended, so ledger rows above the last balance row are checked too.
    mismatches.push(...(await mismatchesIn(db, after, full ? last : null)));
    users += results.length;
    pages += 1;
    if (!full || last === null) break;
    after = last;
  }
  if (mismatches.length > 0) {
    const sample = mismatches.slice(0, SAMPLE);
    log.error('points_reconcile_mismatch', { count: mismatches.length, sample });
    raiseAlert(env, 'ALERT_SETTLEMENT_FAILED', {
      step: 'points_reconcile',
      count: mismatches.length,
      sample,
    });
  }
  log.info('points_reconciled', { users, pages, mismatches: mismatches.length });
  return { users, pages, mismatches };
}

/** The `reconcile_points` cron job (src/cron.ts). */
export async function reconcileJob(env: Env): Promise<void> {
  await reconcilePoints(env);
}
