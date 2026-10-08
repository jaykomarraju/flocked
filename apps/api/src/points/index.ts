// Atomic points movements (spec "Data model" › Atomic points movements; "Modes: Free and Stakes").
//
// Every movement is ONE `db.batch()`, which D1 runs as a single transaction: the balance change and
// the ledger row commit or roll back together. Two constraints in migrations/0001_init.sql do the
// enforcement, so no read-then-write race exists:
//   * `point_balances_non_negative` (CHECK balance >= 0) fails the debit UPDATE when the balance is
//     insufficient, aborting the whole batch (including a caller's entry insert);
//   * `points_ledger_user_scope_reason_ref` (UNIQUE user_id, scope, reason, ref_id) fails a repeated
//     movement, so settlement retries cannot credit twice.
//
// Builders only build statements; `applyMovement` runs them and classifies the outcome.
import { newUlid } from '@flocked/shared';

/** Balance scope for daily rounds; room rounds use the room ID. */
export const GLOBAL_SCOPE = 'global';

/** `points_ledger.reason` (spec "Data model"). */
export const LEDGER_REASONS = [
  'signup',
  'daily_grant',
  'room_grant',
  'stake',
  'payout',
  'rebate',
  'refund',
  'void_refund',
  'creator_award',
  'referral',
  'merge',
  'admin',
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

/** Reasons that move points out of a balance. */
export const DEBIT_REASONS = ['stake', 'merge', 'admin'] as const satisfies readonly LedgerReason[];
export type DebitReason = (typeof DEBIT_REASONS)[number];

/** Reasons that move points into a balance. */
export const CREDIT_REASONS = [
  'signup',
  'daily_grant',
  'room_grant',
  'payout',
  'rebate',
  'refund',
  'void_refund',
  'creator_award',
  'referral',
  'merge',
  'admin',
] as const satisfies readonly LedgerReason[];
export type CreditReason = (typeof CREDIT_REASONS)[number];

/** House-minted grants (credits that are not returns of a stake). */
export const GRANT_REASONS = [
  'signup',
  'daily_grant',
  'room_grant',
  'creator_award',
  'referral',
  'admin',
] as const satisfies readonly CreditReason[];
export type GrantReason = (typeof GRANT_REASONS)[number];

/** Spec "Modes: Free and Stakes": 500 on signup (and on room join), +100 per round below 1,000. */
export const POINTS = {
  signupGrant: 500,
  roomJoinGrant: 500,
  roundGrant: 100,
  roundGrantBelow: 1000,
} as const;

/** The balance scope of a round: `'global'` for daily rounds, the room ID for room rounds. */
export function scopeForRound(round: { kind: 'daily' | 'room'; roomId?: string | null }): string {
  if (round.kind === 'daily') return GLOBAL_SCOPE;
  if (!round.roomId) throw new TypeError('room round without a room ID');
  return round.roomId;
}

/** Statements for one `db.batch()` plus where the ledger inserts sit in it. */
export interface PointsMovement {
  readonly statements: readonly D1PreparedStatement[];
  /** Index in `statements` of each ledger INSERT (a guarded grant's may change 0 rows). */
  readonly ledgerIndexes: readonly number[];
  /** The new ledger row IDs, aligned with `ledgerIndexes`. */
  readonly ledgerIds: readonly string[];
}

interface MovementBase {
  userId: string;
  /** `'global'` or a room ID (`scopeForRound`). */
  scope: string;
  /** Positive integer number of points. */
  amount: number;
  /**
   * Idempotency reference: with (user, scope, reason) it is unique in the ledger. Conventions:
   * round ID for stake, payout, rebate, refund, void_refund, daily_grant, room_grant and
   * creator_award; user ID for signup; room ID for the room-join grant; referee user ID for
   * referral; merge ID for merge; audit_log ID for admin.
   */
  refId: string;
  /** Epoch ms (src/lib/clock.ts `now`). */
  now: number;
  /** Ledger row ID; defaults to a new ULID at `now`. */
  ledgerId?: string;
}

export interface DebitInput extends MovementBase {
  reason: DebitReason;
  /** Statements run between the balance debit and the ledger insert (spec step 3). */
  between?: readonly D1PreparedStatement[];
}

export interface StakeInput extends Omit<MovementBase, 'refId'> {
  /** The round ID (one Free entry per user per round and scope). */
  roundId: string;
  /** The entry insert, with its `receipt_seq` (spec step 3). */
  entryInsert?: D1PreparedStatement;
}

export interface CreditInput extends MovementBase {
  reason: CreditReason;
}

export interface GrantInput extends MovementBase {
  reason: GrantReason;
  /**
   * Grant only while the balance is strictly below this (the daily and room-round grants: 1,000).
   * Checked inside the batch, so it holds under concurrency.
   */
  onlyIfBalanceBelow?: number;
}

function checkBase(m: MovementBase): string {
  if (!Number.isSafeInteger(m.amount) || m.amount <= 0) {
    throw new RangeError('points amount must be a positive safe integer');
  }
  if (!m.userId || !m.scope || !m.refId)
    throw new TypeError('userId, scope and refId are required');
  if (!Number.isSafeInteger(m.now) || m.now < 0) throw new RangeError('now must be epoch ms');
  return m.ledgerId ?? newUlid(m.now);
}

const ENSURE_BALANCE_ROW =
  'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, 0, ?3) ' +
  'ON CONFLICT DO NOTHING';
const DEBIT_BALANCE =
  'UPDATE point_balances SET balance = balance - ?1, updated_at = ?2 WHERE user_id = ?3 AND scope = ?4';
const CREDIT_BALANCE =
  'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, ?3, ?4) ' +
  'ON CONFLICT (user_id, scope) DO UPDATE SET balance = balance + excluded.balance, ' +
  'updated_at = excluded.updated_at';
const INSERT_LEDGER =
  'INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) ' +
  'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)';
const INSERT_LEDGER_IF_BELOW =
  'INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) ' +
  'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE (SELECT balance FROM point_balances ' +
  'WHERE user_id = ?2 AND scope = ?3) < ?8';
const CREDIT_IF_LEDGER_ROW =
  'UPDATE point_balances SET balance = balance + ?1, updated_at = ?2 WHERE user_id = ?3 AND scope = ?4 ' +
  'AND balance < ?6 AND EXISTS (SELECT 1 FROM points_ledger WHERE id = ?5)';

/**
 * A debit: spec steps 1, 2, [3], 4. An insufficient balance fails step 2's CHECK and rolls back
 * every statement, including `between`.
 */
export function debitMovement(db: D1Database, input: DebitInput): PointsMovement {
  const id = checkBase(input);
  const { userId, scope, amount, refId, now, reason } = input;
  const statements = [
    db.prepare(ENSURE_BALANCE_ROW).bind(userId, scope, now),
    db.prepare(DEBIT_BALANCE).bind(amount, now, userId, scope),
    ...(input.between ?? []),
    db.prepare(INSERT_LEDGER).bind(id, userId, scope, -amount, reason, refId, now),
  ];
  return { statements, ledgerIndexes: [statements.length - 1], ledgerIds: [id] };
}

/** A Free stake: the spec's four-step batch, with the caller's entry insert as step 3. */
export function stakeMovement(db: D1Database, input: StakeInput): PointsMovement {
  const { roundId, entryInsert, ...rest } = input;
  return debitMovement(db, {
    ...rest,
    reason: 'stake',
    refId: roundId,
    between: entryInsert ? [entryInsert] : [],
  });
}

/** A credit (payout, rebate, refund, award, …): upsert the balance, insert the ledger row. */
export function creditMovement(db: D1Database, input: CreditInput): PointsMovement {
  const id = checkBase(input);
  const { userId, scope, amount, refId, now, reason } = input;
  const statements = [
    db.prepare(CREDIT_BALANCE).bind(userId, scope, amount, now),
    db.prepare(INSERT_LEDGER).bind(id, userId, scope, amount, reason, refId, now),
  ];
  return { statements, ledgerIndexes: [1], ledgerIds: [id] };
}

/**
 * A house grant with its ledger ref. With `onlyIfBalanceBelow`, the ledger row is inserted only
 * while the balance is below the threshold, and the balance moves only if that row exists and the
 * balance is still below it, so the pair stays consistent and a retry of a committed grant can't
 * credit twice; `applyMovement` then reports `skipped`.
 */
export function grantMovement(db: D1Database, input: GrantInput): PointsMovement {
  if (input.onlyIfBalanceBelow === undefined) return creditMovement(db, input);
  const id = checkBase(input);
  const { userId, scope, amount, refId, now, reason, onlyIfBalanceBelow } = input;
  if (!Number.isSafeInteger(onlyIfBalanceBelow)) {
    throw new RangeError('onlyIfBalanceBelow must be a safe integer');
  }
  const statements = [
    db.prepare(ENSURE_BALANCE_ROW).bind(userId, scope, now),
    db
      .prepare(INSERT_LEDGER_IF_BELOW)
      .bind(id, userId, scope, amount, reason, refId, now, onlyIfBalanceBelow),
    db.prepare(CREDIT_IF_LEDGER_ROW).bind(amount, now, userId, scope, id, onlyIfBalanceBelow),
  ];
  return { statements, ledgerIndexes: [1], ledgerIds: [id] };
}

/**
 * Several movements in one batch, e.g. a merge's paired `merge` rows (debit the losing account,
 * credit the kept one). All of them apply, or none.
 */
export function combineMovements(...movements: PointsMovement[]): PointsMovement {
  const statements: D1PreparedStatement[] = [];
  const ledgerIndexes: number[] = [];
  const ledgerIds: string[] = [];
  for (const m of movements) {
    const offset = statements.length;
    statements.push(...m.statements);
    m.ledgerIndexes.forEach((i, k) => {
      ledgerIndexes.push(offset + i);
      ledgerIds.push(m.ledgerIds[k] as string);
    });
  }
  return { statements, ledgerIndexes, ledgerIds };
}

export type MovementOutcome =
  /** Committed. `ledgerIds` are the rows written (a combined batch may skip a guarded grant). */
  | { status: 'applied'; ledgerIds: string[] }
  /** Committed, but every guarded grant was below its threshold check: nothing changed. */
  | { status: 'skipped' }
  /** Rolled back: a debit would take a balance below zero. */
  | { status: 'insufficient_balance' }
  /** Rolled back: a ledger row with the same (user, scope, reason, ref) exists, i.e. already applied. */
  | { status: 'duplicate' };

/** D1 surfaces SQLite constraint names in the error message. */
export function classifyPointsError(err: unknown): 'insufficient_balance' | 'duplicate' | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('CHECK constraint failed: point_balances_non_negative'))
    return 'insufficient_balance';
  if (msg.includes('UNIQUE constraint failed: points_ledger.')) return 'duplicate';
  return null;
}

/**
 * Runs a movement as one D1 batch. Insufficient balance and duplicate refs are outcomes, not
 * exceptions; any other failure (including a caller's own statements failing) is rethrown, and the
 * batch has rolled back.
 */
export async function applyMovement(
  db: D1Database,
  movement: PointsMovement,
): Promise<MovementOutcome> {
  let results: D1Result[];
  try {
    results = await db.batch([...movement.statements]);
  } catch (err) {
    const kind = classifyPointsError(err);
    if (kind) return { status: kind };
    throw err;
  }
  const written = movement.ledgerIds.filter(
    (_, k) => (results[movement.ledgerIndexes[k] as number]?.meta.changes ?? 0) > 0,
  );
  return written.length > 0 ? { status: 'applied', ledgerIds: written } : { status: 'skipped' };
}

export interface BalanceMismatch {
  userId: string;
  scope: string;
  balance: number;
  ledgerSum: number;
}

/**
 * Every (user, scope) whose balance differs from the sum of its ledger rows, including ledger rows
 * with no balance row. The nightly reconciliation job (spec "Data model") alerts on any result.
 */
export async function findBalanceMismatches(
  db: D1Database,
  opts: { userId?: string } = {},
): Promise<BalanceMismatch[]> {
  const where = opts.userId === undefined ? '' : 'WHERE k.user_id = ?1';
  const sql = `
    WITH keys AS (
      SELECT user_id, scope FROM point_balances
      UNION
      SELECT DISTINCT user_id, scope FROM points_ledger
    )
    SELECT k.user_id AS userId, k.scope AS scope,
           COALESCE((SELECT balance FROM point_balances b
                     WHERE b.user_id = k.user_id AND b.scope = k.scope), 0) AS balance,
           COALESCE((SELECT SUM(delta) FROM points_ledger l
                     WHERE l.user_id = k.user_id AND l.scope = k.scope), 0) AS ledgerSum
    FROM keys k ${where}`;
  const stmt = db.prepare(sql);
  const { results } = await (
    opts.userId === undefined ? stmt : stmt.bind(opts.userId)
  ).all<BalanceMismatch>();
  return results.filter((r) => r.balance !== r.ledgerSum);
}
