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
//
// Anti-farming (spec "Anti-abuse" › Points farming; owner decision Oct 9, 2026): the grant needs an
// account at least 24 hours old with a linked Farcaster identity, or a linked wallet with at least one
// prior onchain transaction. An ineligible user gets neither a grant nor a skip row, so linking later
// the same day still works. The wallet fact needs an RPC read, which can't happen inside the batch:
// `recordPriorTransactions` reads it first (through src/chain/client.ts) and stores it on the wallet
// identity (`data_json.priorTxAt`); the batch then checks D1 only.
import { newUlid } from '@flocked/shared';
import type { Address, Transport } from 'viem';
import { hasPriorTransaction, publicClient, type ChainEnv } from '../chain/client.js';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { HOUR_MS } from './schedule.js';
import {
  GLOBAL_SCOPE,
  POINTS,
  applyMovement,
  type MovementOutcome,
  type PointsMovement,
} from '../points/index.js';

/** The grant needs an account at least this old. */
export const GRANT_MIN_ACCOUNT_AGE_MS = 24 * HOUR_MS;

// ?1 user, ?8 the latest created_at that is old enough (now − 24 h).
const ELIGIBLE =
  'EXISTS (SELECT 1 FROM users u WHERE u.id = ?1 AND u.created_at <= ?8) ' +
  'AND EXISTS (SELECT 1 FROM identities i WHERE i.user_id = ?1 AND i.verified_at IS NOT NULL ' +
  "AND (i.provider = 'farcaster' OR (i.provider = 'wallet' AND json_extract(i.data_json, '$.priorTxAt') IS NOT NULL)))";

const ENSURE_BALANCE_ROW =
  'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, 0, ?3) ' +
  'ON CONFLICT DO NOTHING';
// Records the skip only when the balance is at or above the threshold and no grant was made.
const RECORD_SKIP =
  'INSERT INTO daily_grant_skips (user_id, round_id, balance, skipped_at) ' +
  'SELECT ?1, ?3, b.balance, ?4 FROM point_balances b ' +
  'WHERE b.user_id = ?1 AND b.scope = ?2 AND b.balance >= ?5 ' +
  "AND NOT EXISTS (SELECT 1 FROM points_ledger WHERE user_id = ?1 AND scope = ?2 AND reason = 'daily_grant' AND ref_id = ?3) " +
  `AND ${ELIGIBLE} ` +
  'ON CONFLICT DO NOTHING';
// A retried grant that already committed fails the ledger's unique key (`duplicate`) or, if the
// balance has since reached the threshold, inserts nothing (`skipped`): it never credits twice.
const INSERT_LEDGER =
  'INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) ' +
  "SELECT ?6, ?1, ?2, ?7, 'daily_grant', ?3, ?4 " +
  'WHERE (SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = ?2) < ?5 ' +
  'AND NOT EXISTS (SELECT 1 FROM daily_grant_skips WHERE user_id = ?1 AND round_id = ?3) ' +
  `AND ${ELIGIBLE}`;
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
    i.now - GRANT_MIN_ACCOUNT_AGE_MS,
  ];
  const bind = (sql: string, n: number) => db.prepare(sql).bind(...args.slice(0, n));
  return {
    statements: [
      db.prepare(ENSURE_BALANCE_ROW).bind(i.userId, GLOBAL_SCOPE, i.now),
      bind(RECORD_SKIP, 8),
      bind(INSERT_LEDGER, 8),
      bind(CREDIT_IF_LEDGER_ROW, 7),
    ],
    ledgerIndexes: [2],
    ledgerIds: [id],
  };
}

/**
 * Grants or skips the daily grant for (user, daily round). `applied` = credited now; `skipped` =
 * not credited (balance ≥ 1,000 now or earlier this game day, or not eligible yet); `duplicate` =
 * credited before. Insufficient balance cannot happen (nothing is debited). Call
 * `recordPriorTransactions` first so a wallet-only account's onchain history counts.
 */
export function applyDailyGrant(
  db: D1Database,
  i: { userId: string; roundId: string; now: number },
): Promise<MovementOutcome> {
  return applyMovement(db, dailyGrantMovement(db, i));
}

// The room-round grant (spec "Profiles, leaderboards and rooms" › Room points; owner decision Oct 9,
// 2026, W3-Z carry-over): +100 room points per room round, on the member's first visit or entry after
// the round opens, if the room balance is below 1,000; ledger reason `room_grant`, scope = the room
// ID, ref = the room round's ID. A skip is final for that round and recorded in `daily_grant_skips`,
// keyed by the room round. The daily grant's anti-farming rule doesn't apply (room points pay
// nothing outside the room). The join grant (500, ref = the room ID) is `grantMovement`'s.
// ?1 user, ?2 room (scope), ?3 room round, ?4 now, ?5 threshold, ?6 ledger ID, ?7 amount.
const ROOM_RECORD_SKIP =
  'INSERT INTO daily_grant_skips (user_id, round_id, balance, skipped_at) ' +
  'SELECT ?1, ?3, b.balance, ?4 FROM point_balances b ' +
  'WHERE b.user_id = ?1 AND b.scope = ?2 AND b.balance >= ?5 ' +
  "AND NOT EXISTS (SELECT 1 FROM points_ledger WHERE user_id = ?1 AND scope = ?2 AND reason = 'room_grant' AND ref_id = ?3) " +
  'ON CONFLICT DO NOTHING';
const ROOM_INSERT_LEDGER =
  'INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) ' +
  "SELECT ?6, ?1, ?2, ?7, 'room_grant', ?3, ?4 " +
  'WHERE (SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = ?2) < ?5 ' +
  'AND NOT EXISTS (SELECT 1 FROM daily_grant_skips WHERE user_id = ?1 AND round_id = ?3)';

/** The batch for one room-round grant decision (see above). */
export function roomGrantMovement(
  db: D1Database,
  i: { userId: string; roomId: string; roundId: string; now: number; ledgerId?: string },
): PointsMovement {
  const id = i.ledgerId ?? newUlid(i.now);
  const args = [
    i.userId,
    i.roomId,
    i.roundId,
    i.now,
    POINTS.roundGrantBelow,
    id,
    POINTS.roundGrant,
  ];
  const bind = (sql: string, n: number) => db.prepare(sql).bind(...args.slice(0, n));
  return {
    statements: [
      db.prepare(ENSURE_BALANCE_ROW).bind(i.userId, i.roomId, i.now),
      bind(ROOM_RECORD_SKIP, 5),
      bind(ROOM_INSERT_LEDGER, 7),
      bind(CREDIT_IF_LEDGER_ROW, 7),
    ],
    ledgerIndexes: [2],
    ledgerIds: [id],
  };
}

/**
 * Grants or skips the room grant for (member, room round): `applied` = credited now; `skipped` = the
 * room balance is ≥ 1,000 now or was earlier for this round; `duplicate` = credited before. The
 * caller checks membership and that the round is open.
 */
export function applyRoomGrant(
  db: D1Database,
  i: { userId: string; roomId: string; roundId: string; now: number },
): Promise<MovementOutcome> {
  return applyMovement(db, roomGrantMovement(db, i));
}

/** True when the user passes the anti-farming rule now (D1 facts only; see the header). */
export async function dailyGrantEligible(
  db: D1Database,
  i: { userId: string; now: number },
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok WHERE ${ELIGIBLE}`)
    .bind(i.userId, null, null, null, null, null, null, i.now - GRANT_MIN_ACCOUNT_AGE_MS)
    .first<{ ok: number }>();
  return row !== null;
}

// Wallet identities whose onchain history is unknown, for a user the grant could still be decided
// for: old enough, no Farcaster identity (which suffices), and no grant or skip for the round yet.
const UNCHECKED_WALLETS =
  "SELECT w.id, w.external_id FROM identities w WHERE w.user_id = ?1 AND w.provider = 'wallet' " +
  "AND w.verified_at IS NOT NULL AND json_extract(w.data_json, '$.priorTxAt') IS NULL " +
  'AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?1 AND u.created_at <= ?3) ' +
  "AND NOT EXISTS (SELECT 1 FROM identities f WHERE f.user_id = ?1 AND f.provider = 'farcaster' AND f.verified_at IS NOT NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM points_ledger l WHERE l.user_id = ?1 AND l.scope = 'global' AND l.reason = 'daily_grant' AND l.ref_id = ?2) " +
  'AND NOT EXISTS (SELECT 1 FROM daily_grant_skips s WHERE s.user_id = ?1 AND s.round_id = ?2)';

/**
 * Before a daily grant decision: reads each of the user's linked wallets that might make them
 * eligible, and marks those with a prior onchain transaction (`identities.data_json.priorTxAt`, set
 * once and never cleared: a nonce never goes back). Does nothing (no RPC) when the answer can't change
 * the grant. An RPC failure is logged and leaves the wallet unmarked.
 */
export async function recordPriorTransactions(
  env: Pick<Env, 'DB'> & ChainEnv,
  i: { userId: string; roundId: string; now: number },
  deps: { transport?: Transport } = {},
): Promise<void> {
  const { results } = await env.DB.prepare(UNCHECKED_WALLETS)
    .bind(i.userId, i.roundId, i.now - GRANT_MIN_ACCOUNT_AGE_MS)
    .all<{ id: string; external_id: string }>();
  if (results.length === 0) return;
  let client;
  try {
    client = publicClient(env, deps.transport);
  } catch (err) {
    log.warn('grant_wallet_check_unavailable', { error: String(err) });
    return;
  }
  for (const w of results) {
    try {
      if (!(await hasPriorTransaction(client, w.external_id as Address))) continue;
      await env.DB.prepare(
        "UPDATE identities SET data_json = json_set(data_json, '$.priorTxAt', ?2) WHERE id = ?1",
      )
        .bind(w.id, i.now)
        .run();
      return; // one wallet is enough
    } catch (err) {
      log.warn('grant_wallet_check_failed', { error: String(err) });
    }
  }
}
