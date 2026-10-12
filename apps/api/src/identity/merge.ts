// Merging accounts (spec "Identity and personhood" › Merging accounts). Linking an identity that
// another account holds, or a Coinbase person ID bound to another account, creates a pending merge;
// nothing merges automatically, and never inside an OAuth callback. Either account confirms it in
// an authenticated session by signing in to the other account with one of that account's own
// sign-in identities, within 7 days.
//
// Confirmation is one D1 batch. The account created first is kept and takes: the non-null person ID
// and its verification data; the lower daily cap and any pending increase with its original timer;
// every identity; each points balance through paired `merge` ledger rows (ref = merge ID); room
// memberships and ownership; and the losing account's Stakes tickets for the current and later
// game days, so the daily cap and the one-live-ticket rule hold per person (W6-Z carry-over). The
// losing account becomes `merged`, its sessions are revoked, and an `audit_log` row records it.
// Guards inside the batch re-check every refusal rule, so a racing change rolls it all back.
import { newUlid, type Merge, type Provider } from '@flocked/shared';
import { enqueueSecurityNotice } from '../auth/accounts.js';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { excludedSql } from '../limits/rules.js';
import {
  combineMovements,
  creditMovement,
  debitMovement,
  classifyPointsError,
  type PointsMovement,
} from '../points/index.js';
import { DEFAULT_DAILY_STAKE_CAP, effectiveDailyCap } from '../stakes/cap.js';
import { keptFirst, loadAccount, mergeView, type AccountRow, type MergeRow } from './accounts.js';
import type { ProvenIdentity } from './proof.js';
import {
  abortIf,
  auditStatement,
  carryTicketsStatement,
  hasOpenEntrySql,
  isGuardAbort,
} from './sql.js';

/** A pending merge waits this long for confirmation (Decision log, Oct 12, 2026). */
export const MERGE_PENDING_TTL_MS = 7 * 24 * 3600 * 1000;
/** The kept account takes at most one merge per this period (spec: 30 days). */
export const MERGE_LIMIT_MS = 30 * 24 * 3600 * 1000;

type NotifyEnv = Pick<Env, 'DB' | 'QUEUE_NOTIFY'>;

const MERGE_COLUMNS =
  'm.id, m.kept_user_id, m.losing_user_id, m.identity_id, m.status, m.expires_at, m.created_at, m.confirmed_at';

/** What creating a pending merge needs to know about each account. */
export type MergeParty = Pick<AccountRow, 'id' | 'person_id' | 'created_at' | 'handle'>;

/** Both accounts hold a person ID and they differ (spec: such a merge is refused). */
function personsDiffer(a: MergeParty, b: MergeParty): boolean {
  return a.person_id !== null && b.person_id !== null && a.person_id !== b.person_id;
}

/**
 * The pending merge between `me` and `other`, the account holding the identity `identityId`;
 * an open one for the same two accounts is reused. Two accounts with different person IDs are
 * refused here already (`merge_blocked`). The other account gets a `merge_pending` notice.
 */
export async function createPendingMerge(
  env: NotifyEnv,
  me: MergeParty,
  other: MergeParty,
  identityId: string,
  t: number,
): Promise<Merge> {
  if (personsDiffer(me, other)) {
    throw new HttpError('merge_blocked', 'These accounts belong to different verified people');
  }
  const db = env.DB;
  const [kept, losing] = keptFirst(me, other);
  const id = newUlid(t);
  await db.batch([
    // A pending row past its expiry blocks the pair's unique index until it is marked expired.
    db
      .prepare(
        "UPDATE merges SET status = 'expired' WHERE kept_user_id = ?1 AND losing_user_id = ?2 " +
          "AND status = 'pending' AND expires_at <= ?3",
      )
      .bind(kept.id, losing.id, t),
    db
      .prepare(
        'INSERT INTO merges (id, kept_user_id, losing_user_id, identity_id, status, expires_at, created_at) ' +
          "VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6) ON CONFLICT DO NOTHING",
      )
      .bind(id, kept.id, losing.id, identityId, t + MERGE_PENDING_TTL_MS, t),
  ]);
  const row = await db
    .prepare(
      `SELECT ${MERGE_COLUMNS}, i.provider FROM merges m LEFT JOIN identities i ON i.id = m.identity_id ` +
        "WHERE m.kept_user_id = ?1 AND m.losing_user_id = ?2 AND m.status = 'pending'",
    )
    .bind(kept.id, losing.id)
    .first<MergeRow & { provider: Provider | null }>();
  if (!row) throw new Error('pending merge not found after insert');
  if (row.id === id) {
    log.info('merge_pending_created', { mergeId: id });
    await enqueueSecurityNotice(env, other.id, 'merge_pending', t);
  }
  return mergeView(row, row.provider ?? 'coinbase', other.handle);
}

interface LimitsCapRow {
  daily_stake_cap: number | null;
  pending_cap: number | null;
  pending_cap_effective_at: number | null;
  question_block_until: number | null;
}

/**
 * The kept account's cap state: the lower of the two caps in force, and the most restrictive
 * pending increase still waiting (the lower amount; on a tie the later timer), with its own timer.
 */
export function mergedCapState(
  a: LimitsCapRow | null,
  b: LimitsCapRow | null,
  t: number,
): LimitsCapRow {
  const cap = [effectiveDailyCap(a, t), effectiveDailyCap(b, t)].reduce((x, y) => (y < x ? y : x));
  const explicit = [a, b].some((r) => r?.daily_stake_cap != null || r?.pending_cap != null);
  const pending = [a, b]
    .filter(
      (r): r is LimitsCapRow & { pending_cap: number; pending_cap_effective_at: number } =>
        r?.pending_cap != null &&
        r.pending_cap_effective_at != null &&
        r.pending_cap_effective_at > t &&
        BigInt(r.pending_cap) > cap,
    )
    .sort(
      (x, y) =>
        x.pending_cap - y.pending_cap || y.pending_cap_effective_at - x.pending_cap_effective_at,
    )[0];
  const blocks = [a?.question_block_until, b?.question_block_until].filter(
    (v): v is number => v != null,
  );
  return {
    daily_stake_cap: explicit || cap !== DEFAULT_DAILY_STAKE_CAP ? Number(cap) : null,
    pending_cap: pending?.pending_cap ?? null,
    pending_cap_effective_at: pending?.pending_cap_effective_at ?? null,
    question_block_until: blocks.length > 0 ? Math.max(...blocks) : null,
  };
}

/** SQL (params ?1 user, ?2 cap, ?3 pending, ?4 effective at): the user's cap state is as read. */
const CAP_STATE_IS =
  'EXISTS (SELECT 1 FROM limits WHERE user_id = ?1 AND daily_stake_cap IS ?2 AND pending_cap IS ?3 ' +
  'AND pending_cap_effective_at IS ?4)';
const CAP_STATE_UNSET =
  'NOT EXISTS (SELECT 1 FROM limits WHERE user_id = ?1 AND (daily_stake_cap IS NOT NULL OR pending_cap IS NOT NULL))';

function capStateUnchanged(db: D1Database, userId: string, row: LimitsCapRow | null) {
  return row
    ? abortIf(
        db,
        `NOT ${CAP_STATE_IS}`,
        userId,
        row.daily_stake_cap,
        row.pending_cap,
        row.pending_cap_effective_at,
      )
    : abortIf(db, `NOT ${CAP_STATE_UNSET}`, userId);
}

/** Refusal messages, in the spec's order. */
function refusal(
  me: AccountRow,
  other: AccountRow,
  state: { openEntries: boolean; excluded: boolean; recentMerge: boolean },
): string | null {
  if (state.openEntries) return 'One of the accounts has entries in a round that is not final yet';
  if (personsDiffer(me, other)) return 'These accounts belong to different verified people';
  if (me.status === 'suspended' || other.status === 'suspended') {
    return 'A suspended account cannot be merged';
  }
  if (state.excluded) return 'A self-excluded account cannot be merged';
  if (state.recentMerge) return 'The kept account already received a merge in the last 30 days';
  return null;
}

/** Confirms the caller's pending merge `mergeId` with proof of the other account's sign-in. */
export async function confirmMerge(
  env: Env,
  callerId: string,
  mergeId: string,
  proven: ProvenIdentity,
  t: number,
): Promise<Merge> {
  const db = env.DB;
  const merge = await db
    .prepare(
      `SELECT ${MERGE_COLUMNS}, i.provider FROM merges m LEFT JOIN identities i ON i.id = m.identity_id WHERE m.id = ?1`,
    )
    .bind(mergeId)
    .first<MergeRow & { provider: Provider | null }>();
  if (!merge || (merge.kept_user_id !== callerId && merge.losing_user_id !== callerId)) {
    throw new HttpError('not_found', 'No such merge');
  }
  const otherId = merge.kept_user_id === callerId ? merge.losing_user_id : merge.kept_user_id;
  const provider = merge.provider ?? proven.provider;
  if (merge.status === 'confirmed') {
    const other = await loadAccount(db, otherId);
    return mergeView(merge, provider, other?.handle ?? null);
  }
  if (merge.status !== 'pending') {
    throw new HttpError(
      merge.status === 'expired' ? 'merge_expired' : 'merge_blocked',
      `This merge was ${merge.status}`,
    );
  }

  const [me, other] = await Promise.all([loadAccount(db, callerId), loadAccount(db, otherId)]);
  const live = (a: AccountRow | null): a is AccountRow =>
    a !== null && (a.status === 'active' || a.status === 'suspended');
  if (merge.expires_at <= t || !live(me) || !live(other)) {
    await db
      .prepare("UPDATE merges SET status = 'expired' WHERE id = ?1 AND status = 'pending'")
      .bind(mergeId)
      .run();
    throw new HttpError('merge_expired', 'This merge has expired; link the identity again');
  }

  // The proof must sign in to the other account itself (not to an account merged into it).
  const signIn = await db
    .prepare(
      'SELECT user_id FROM identities WHERE provider = ?1 AND external_id = ?2 AND verified_at IS NOT NULL',
    )
    .bind(proven.provider, proven.externalId)
    .first<{ user_id: string }>();
  if (signIn?.user_id !== otherId) {
    throw new HttpError('forbidden', 'Sign in to the other account to confirm this merge');
  }

  const [kept, losing] = me.id === merge.kept_user_id ? [me, other] : [other, me];
  const checks = await db
    .prepare(
      `SELECT ${hasOpenEntrySql('?1')} OR ${hasOpenEntrySql('?2')} AS open_entries, ` +
        `${excludedSql('?1', '?3')} OR ${excludedSql('?2', '?3')} AS excluded, ` +
        "EXISTS (SELECT 1 FROM merges WHERE kept_user_id = ?1 AND status = 'confirmed' AND confirmed_at > ?4) AS recent",
    )
    .bind(kept.id, losing.id, t, t - MERGE_LIMIT_MS)
    .first<{ open_entries: number; excluded: number; recent: number }>();
  const refused = refusal(me, other, {
    openEntries: checks?.open_entries === 1,
    excluded: checks?.excluded === 1,
    recentMerge: checks?.recent === 1,
  });
  if (refused) {
    if (personsDiffer(me, other)) {
      await db
        .prepare("UPDATE merges SET status = 'refused' WHERE id = ?1 AND status = 'pending'")
        .bind(mergeId)
        .run();
    }
    throw new HttpError('merge_blocked', refused);
  }

  const statements = await transferStatements(db, merge, kept, losing, callerId, t);
  try {
    await db.batch(statements);
  } catch (err) {
    if (isGuardAbort(err) || classifyPointsError(err) !== null) {
      log.warn('merge_confirm_raced', { mergeId });
      throw new HttpError('conflict', 'The accounts changed while merging; try again');
    }
    throw err;
  }
  log.info('merge_confirmed', { mergeId, keptUserId: kept.id, losingUserId: losing.id });
  await enqueueSecurityNotice(env, kept.id, 'merge_completed', t);
  return mergeView({ ...merge, status: 'confirmed', confirmed_at: t }, provider, other.handle);
}

/** The confirmation batch: guards first, then every transfer, then the losing account's end. */
async function transferStatements(
  db: D1Database,
  merge: MergeRow,
  kept: AccountRow,
  losing: AccountRow,
  callerId: string,
  t: number,
): Promise<D1PreparedStatement[]> {
  const [limitsRows, balances] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT user_id, daily_stake_cap, pending_cap, pending_cap_effective_at, question_block_until ' +
          'FROM limits WHERE user_id IN (?1, ?2)',
      )
      .bind(kept.id, losing.id),
    db
      .prepare('SELECT scope, balance FROM point_balances WHERE user_id = ?1 AND balance > 0')
      .bind(losing.id),
  ]);
  const limitsOf = (id: string) =>
    ((limitsRows?.results ?? []) as unknown as (LimitsCapRow & { user_id: string })[]).find(
      (r) => r.user_id === id,
    ) ?? null;
  const keptLimits = limitsOf(kept.id);
  const losingLimits = limitsOf(losing.id);
  const moved = (balances?.results ?? []) as unknown as { scope: string; balance: number }[];

  const statements: D1PreparedStatement[] = [
    // The merge is still pending and unexpired, and this batch is the one confirming it.
    db
      .prepare(
        "UPDATE merges SET status = 'confirmed', confirmed_at = ?2 WHERE id = ?1 AND status = 'pending' AND expires_at > ?2",
      )
      .bind(merge.id, t),
    abortIf(
      db,
      "NOT EXISTS (SELECT 1 FROM merges WHERE id = ?1 AND status = 'confirmed' AND confirmed_at = ?2)",
      merge.id,
      t,
    ),
    // Every refusal rule, again inside the transaction.
    abortIf(
      db,
      "EXISTS (SELECT 1 FROM merges WHERE kept_user_id = ?1 AND status = 'confirmed' AND confirmed_at > ?2 AND id <> ?3)",
      kept.id,
      t - MERGE_LIMIT_MS,
      merge.id,
    ),
    abortIf(
      db,
      "(SELECT count(*) FROM users WHERE id IN (?1, ?2) AND status = 'active') <> 2",
      kept.id,
      losing.id,
    ),
    abortIf(
      db,
      `${hasOpenEntrySql('?1')} OR ${hasOpenEntrySql('?2')} OR ${excludedSql('?1', '?3')} OR ${excludedSql('?2', '?3')}`,
      kept.id,
      losing.id,
      t,
    ),
    capStateUnchanged(db, kept.id, keptLimits),
    capStateUnchanged(db, losing.id, losingLimits),
  ];

  // The person ID and its verification data (spec: the kept account takes the non-null one).
  if (losing.person_id !== null && kept.person_id === null) {
    statements.push(
      abortIf(
        db,
        'NOT EXISTS (SELECT 1 FROM users WHERE id = ?1 AND person_id = ?2)',
        losing.id,
        losing.person_id,
      ),
      db
        .prepare(
          'UPDATE users SET person_id = NULL, kyc_status = NULL, person_verified_at = NULL, ' +
            'coinbase_country = NULL, coinbase_region = NULL WHERE id = ?1',
        )
        .bind(losing.id),
      db
        .prepare(
          'UPDATE users SET person_id = ?2, kyc_status = ?3, person_verified_at = ?4, coinbase_country = ?5, ' +
            'coinbase_region = ?6 WHERE id = ?1 AND person_id IS NULL',
        )
        .bind(
          kept.id,
          losing.person_id,
          losing.kyc_status,
          losing.person_verified_at,
          losing.coinbase_country,
          losing.coinbase_region,
        ),
      abortIf(
        db,
        'NOT EXISTS (SELECT 1 FROM users WHERE id = ?1 AND person_id = ?2)',
        kept.id,
        losing.person_id,
      ),
    );
  }

  // The lower cap and any pending increase with its original timer.
  const cap = mergedCapState(keptLimits, losingLimits, t);
  statements.push(
    db
      .prepare(
        'INSERT INTO limits (user_id, daily_stake_cap, pending_cap, pending_cap_effective_at, question_block_until) ' +
          'VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (user_id) DO UPDATE SET ' +
          'daily_stake_cap = excluded.daily_stake_cap, pending_cap = excluded.pending_cap, ' +
          'pending_cap_effective_at = excluded.pending_cap_effective_at, ' +
          'question_block_until = excluded.question_block_until',
      )
      .bind(
        kept.id,
        cap.daily_stake_cap,
        cap.pending_cap,
        cap.pending_cap_effective_at,
        cap.question_block_until,
      ),
    // Every identity, the coinbase one included.
    db.prepare('UPDATE identities SET user_id = ?1 WHERE user_id = ?2').bind(kept.id, losing.id),
    // Room memberships (the owner role wins) and ownership; a balance row for each room.
    db
      .prepare(
        'INSERT INTO room_members (room_id, user_id, role, joined_at) ' +
          'SELECT room_id, ?1, role, joined_at FROM room_members WHERE user_id = ?2 ' +
          'ON CONFLICT (room_id, user_id) DO UPDATE SET ' +
          "role = CASE WHEN excluded.role = 'owner' THEN 'owner' ELSE room_members.role END, " +
          'joined_at = min(room_members.joined_at, excluded.joined_at)',
      )
      .bind(kept.id, losing.id),
    db
      .prepare(
        'INSERT INTO point_balances (user_id, scope, balance, updated_at) ' +
          'SELECT ?1, room_id, 0, ?3 FROM room_members WHERE user_id = ?2 ON CONFLICT DO NOTHING',
      )
      .bind(kept.id, losing.id, t),
    db.prepare('DELETE FROM room_members WHERE user_id = ?1').bind(losing.id),
    db
      .prepare('UPDATE rooms SET owner_user_id = ?1 WHERE owner_user_id = ?2')
      .bind(kept.id, losing.id),
    // Stakes tickets of today and later, so the cap and the live-ticket rule count one person.
    carryTicketsStatement(db, { from: '?2', to: '?1' }, t, kept.id, losing.id),
  );

  // Balances, per scope, through paired `merge` ledger rows.
  const movements: PointsMovement[] = [];
  for (const { scope, balance } of moved) {
    movements.push(
      debitMovement(db, {
        userId: losing.id,
        scope,
        amount: balance,
        reason: 'merge',
        refId: merge.id,
        now: t,
      }),
      creditMovement(db, {
        userId: kept.id,
        scope,
        amount: balance,
        reason: 'merge',
        refId: merge.id,
        now: t,
      }),
    );
  }
  statements.push(
    ...combineMovements(...movements).statements,
    // Nothing is left behind (a balance that grew since the read rolls the merge back).
    abortIf(
      db,
      'EXISTS (SELECT 1 FROM point_balances WHERE user_id = ?1 AND balance <> 0)',
      losing.id,
    ),
    // The losing account ends; accounts merged into it now point at the kept one.
    db
      .prepare("UPDATE users SET status = 'merged', merged_into = ?1 WHERE id = ?2")
      .bind(kept.id, losing.id),
    db.prepare('UPDATE users SET merged_into = ?1 WHERE merged_into = ?2').bind(kept.id, losing.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(losing.id),
    db
      .prepare(
        "UPDATE merges SET status = 'expired' WHERE status = 'pending' AND id <> ?2 " +
          'AND (kept_user_id = ?1 OR losing_user_id = ?1)',
      )
      .bind(losing.id, merge.id),
    auditStatement(db, {
      actor: 'user',
      actorUserId: callerId,
      action: 'merge_confirmed',
      target: kept.id,
      data: {
        mergeId: merge.id,
        keptUserId: kept.id,
        losingUserId: losing.id,
        balances: Object.fromEntries(moved.map((b) => [b.scope, b.balance])),
        personMoved: losing.person_id !== null && kept.person_id === null,
      },
      now: t,
    }),
  );
  return statements;
}

/** Statements that expire every pending merge `userId` is part of (account deletion). */
export function expireMergesStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE merges SET status = 'expired' WHERE status = 'pending' AND (kept_user_id = ?1 OR losing_user_id = ?1)",
    )
    .bind(userId);
}
