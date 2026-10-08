// Free entry checks and the D1 statements of the commit protocol (spec "Real-time and the reveal" ›
// RoundDO responsibilities; "Sealed picks" › Canonical ciphertext header; "Data model" rows
// entries, limits and room_members, and "Atomic points movements").
import type { CreateEntryRequest, ErrorCode, FreeLockedConfig } from '@flocked/shared';
import { commitment, fromBase64Url, isCanonicalHeader, type DrandChain } from '@flocked/tlock';
import type { Hex } from 'viem';

/** FlockedEscrow's ciphertext cap; Free submits are held to the same bound. */
export const MAX_CIPHERTEXT_BYTES = 2048;

export interface EntryRejection {
  code: ErrorCode;
  message: string;
}

export function reject(code: ErrorCode, message: string): EntryRejection {
  return { code, message };
}

export function isRejection(x: unknown): x is EntryRejection {
  return typeof x === 'object' && x !== null && 'code' in x && 'message' in x;
}

export interface CheckedBody {
  stake: bigint;
  ciphertext: Uint8Array;
  commitment: Hex;
}

/**
 * The request-only checks: the stake is an integer within the locked range, and the ciphertext is at
 * most 2,048 bytes with a canonical header that targets the locked `beaconRound` on the pinned chain.
 */
export function checkEntryBody(
  body: CreateEntryRequest,
  rules: { free: FreeLockedConfig; beaconRound: number; chain: DrandChain },
): CheckedBody | EntryRejection {
  const stake = BigInt(body.stake); // DecimalBigintSchema: a canonical non-negative decimal
  const min = BigInt(rules.free.stakeMin);
  const max = BigInt(rules.free.stakeMax);
  if (stake < min || stake > max) {
    return reject('stake_out_of_range', `stake must be between ${min} and ${max} points`);
  }
  // D1 stores points as INTEGER and binds JS numbers (the locked config's stakeMax is meant to stay
  // ≤ 2^53 − 1; see the W4-A carry-over), so a larger stake can never be committed exactly.
  if (stake > BigInt(Number.MAX_SAFE_INTEGER)) {
    return reject('stake_out_of_range', 'stake is too large');
  }
  const ct = fromBase64Url(body.ciphertext);
  if (!ct || ct.length === 0) return reject('invalid_ciphertext', 'ciphertext is not base64url');
  if (ct.length > MAX_CIPHERTEXT_BYTES) {
    return reject('invalid_ciphertext', `ciphertext exceeds ${MAX_CIPHERTEXT_BYTES} bytes`);
  }
  if (!isCanonicalHeader(ct, rules.chain, rules.beaconRound)) {
    return reject(
      'invalid_ciphertext',
      'ciphertext header is not canonical or does not target the round',
    );
  }
  return { stake, ciphertext: ct, commitment: commitment(ct) };
}

// ---- Eligibility (D1) -----------------------------------------------------------------------

/** The user's status, the exclusion columns of `limits`, and room membership, in one query. */
interface EligibilityRow {
  status: string;
  self_exclusion_until: number | null;
  self_exclusion_permanent: number | null;
  exclusion_lift_effective_at: number | null;
  member: number;
}

/**
 * The single self-exclusion rule (spec "Data model" › limits): excluded while
 * `self_exclusion_until` > now, or while permanent and not lifted (`exclusion_lift_effective_at`
 * unset or in the future). Times are epoch ms.
 */
export function isSelfExcluded(
  l: {
    self_exclusion_until: number | null;
    self_exclusion_permanent: number | null;
    exclusion_lift_effective_at: number | null;
  },
  now: number,
): boolean {
  if (l.self_exclusion_until !== null && l.self_exclusion_until > now) return true;
  return (
    l.self_exclusion_permanent === 1 &&
    (l.exclusion_lift_effective_at === null || l.exclusion_lift_effective_at > now)
  );
}

const ELIGIBILITY_SQL =
  'SELECT u.status, l.self_exclusion_until, l.self_exclusion_permanent, ' +
  'l.exclusion_lift_effective_at, ' +
  'EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = ?2 AND m.user_id = u.id) AS member ' +
  'FROM users u LEFT JOIN limits l ON l.user_id = u.id WHERE u.id = ?1';

/** The user is active, not self-excluded, and (for a room round) a member of the room. */
export async function checkEligibility(
  db: D1Database,
  i: { userId: string; roomId: string | null; now: number },
): Promise<EntryRejection | null> {
  const row = await db
    .prepare(ELIGIBILITY_SQL)
    .bind(i.userId, i.roomId ?? '')
    .first<EligibilityRow>();
  if (!row) return reject('unauthorized', 'unknown user');
  if (row.status === 'suspended') return reject('account_suspended', 'account is suspended');
  if (row.status !== 'active') return reject('account_deleted', 'account is not active');
  if (isSelfExcluded(row, i.now)) return reject('self_excluded', 'entries are paused');
  if (i.roomId !== null && row.member !== 1) {
    return reject('not_member', 'only room members can enter');
  }
  return null;
}

// ---- The entry insert (step 3 of the stake batch) --------------------------------------------

/**
 * Step 3 of the stake batch: the entry insert. Two things happen inside D1's transaction:
 *   * `receipt_seq` is allocated at commit, as one more than the round's highest Free seq. Batches
 *     are transactions that D1 runs one at a time, so committed seqs are 0, 1, 2, … with no gaps,
 *     and a batch that rolls back (insufficient balance, duplicate) consumes nothing. The partial
 *     unique index (round_id, mode, receipt_seq) backs this up.
 *   * the insert is refused unless the round is still `open` in D1 (`created_at` becomes NULL and
 *     fails NOT NULL, rolling back the debit too). The RoundDO marks the round `closed` in D1 after
 *     draining in-flight entries at close and before reading the entries for the root, so no
 *     straggling write can commit an entry that the root misses.
 * `RETURNING receipt_seq` hands the allocated seq back.
 */
export function entryInsert(
  db: D1Database,
  e: {
    id: string;
    roundId: string;
    userId: string;
    stake: number;
    ciphertext: Uint8Array;
    commitment: Hex;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO entries (id, round_id, mode, user_id, stake, ciphertext, commitment, receipt_seq, created_at) ' +
        "SELECT ?1, ?2, 'free', ?3, ?4, ?5, ?6, " +
        "(SELECT COALESCE(MAX(receipt_seq) + 1, 0) FROM entries WHERE round_id = ?2 AND mode = 'free' AND receipt_seq IS NOT NULL), " +
        "CASE WHEN (SELECT status FROM rounds WHERE id = ?2) = 'open' THEN ?7 END " +
        'RETURNING receipt_seq',
    )
    .bind(e.id, e.roundId, e.userId, e.stake, e.ciphertext, e.commitment, e.now);
}

/** SQLite's message when the round was no longer open in D1 at commit. */
export function isRoundSealedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('NOT NULL constraint failed: entries.created_at');
}

/** A committed Free entry, as the leaf and receipt need it. */
export interface CommittedEntry {
  id: string;
  userId: string;
  stake: number;
  commitment: Hex;
  seq: number;
  createdAt: number;
}

interface EntryRow {
  id: string;
  user_id: string;
  stake: number;
  commitment: string;
  receipt_seq: number;
  created_at: number;
}

const toCommitted = (r: EntryRow): CommittedEntry => ({
  id: r.id,
  userId: r.user_id,
  stake: r.stake,
  commitment: r.commitment as Hex,
  seq: r.receipt_seq,
  createdAt: r.created_at,
});

const ENTRY_COLUMNS = 'id, user_id, stake, commitment, receipt_seq, created_at';

/** The user's committed Free entry in the round, if any. */
export async function findFreeEntry(
  db: D1Database,
  roundId: string,
  userId: string,
): Promise<CommittedEntry | null> {
  const row = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS} FROM entries WHERE round_id = ?1 AND mode = 'free' AND user_id = ?2`,
    )
    .bind(roundId, userId)
    .first<EntryRow>();
  return row ? toCommitted(row) : null;
}

/** Every committed Free entry of the round, by seq. */
export async function listFreeEntries(db: D1Database, roundId: string): Promise<CommittedEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS} FROM entries WHERE round_id = ?1 AND mode = 'free' ` +
        'AND receipt_seq IS NOT NULL ORDER BY receipt_seq',
    )
    .bind(roundId)
    .all<EntryRow>();
  return results.map(toCommitted);
}
