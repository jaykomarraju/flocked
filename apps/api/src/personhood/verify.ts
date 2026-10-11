// Applies a completed Coinbase sign-in to the account that started it (spec "Identity and
// personhood" › Personhood, Merging accounts, Account deletion). What is stored: `person_id` (an
// HMAC), the country and region codes, `kyc_status`, and the coinbase identity (external_id =
// person_id). Nothing else from Coinbase reaches D1.
//
// - The person ID bound to another account: a pending merge (never a merge inside the callback;
//   W7-B builds the confirmation). Nothing is set on the caller's account.
// - The caller already bound to a different person ID: refused (`person_mismatch`).
// - A person tombstone for this ID (a deleted account of the same person): its daily cap state is
//   copied into the account's `limits` and the tombstone is deleted, in the same batch as the bind.
//   The stricter of two caps wins, and an inherited pending increase keeps its original timer.
// - No personal details: the person ID is still bound (so the Coinbase account cannot verify a
//   second account), with `kyc_status = 'unverified'` and no country, which is "not verified".
import { newUlid, type Merge, type PersonhoodCallbackResponse } from '@flocked/shared';
import { enqueueSecurityNotice } from '../auth/accounts.js';
import { log } from '../lib/log.js';
import type { PersonLocation } from './coinbase.js';
import type { PersonhoodEnv } from './config.js';

/** A pending merge waits this long for confirmation (the spec sets no TTL; a W5-B spec issue). */
export const MERGE_PENDING_TTL_MS = 7 * 24 * 3600 * 1000;

export const PERSONHOOD_FAILURES = [
  'invalid_state',
  'denied',
  'coinbase_error',
  'not_id_verified',
  'person_mismatch',
  'account_unavailable',
  'unavailable',
] as const;
export type PersonhoodFailure = (typeof PERSONHOOD_FAILURES)[number];

export const failed = (reason: PersonhoodFailure): PersonhoodCallbackResponse => ({
  status: 'failed',
  reason,
});

interface AccountRow {
  id: string;
  status: string;
  person_id: string | null;
  created_at: number;
  handle: string | null;
}

async function account(db: D1Database, where: 'id' | 'person_id', value: string) {
  return db
    .prepare(`SELECT id, status, person_id, created_at, handle FROM users WHERE ${where} = ?1`)
    .bind(value)
    .first<AccountRow>();
}

/**
 * The pending merge between `me` and `other` (the account holding the person ID), reusing an open
 * one between the same two accounts. The kept account is the one created first.
 */
async function pendingMerge(
  env: PersonhoodEnv,
  me: AccountRow,
  other: AccountRow,
  personId: string,
  t: number,
): Promise<PersonhoodCallbackResponse> {
  const db = env.DB;
  const identity = await db
    .prepare("SELECT id FROM identities WHERE provider = 'coinbase' AND external_id = ?1")
    .bind(personId)
    .first<{ id: string }>();
  if (!identity) {
    log.error('personhood_identity_missing', { userId: other.id });
    return failed('unavailable');
  }
  const meFirst =
    me.created_at < other.created_at || (me.created_at === other.created_at && me.id < other.id);
  const [kept, losing] = meFirst ? [me, other] : [other, me];
  const open = await db
    .prepare(
      "SELECT id, created_at, expires_at FROM merges WHERE status = 'pending' AND expires_at > ?3 AND " +
        '((kept_user_id = ?1 AND losing_user_id = ?2) OR (kept_user_id = ?2 AND losing_user_id = ?1))',
    )
    .bind(kept.id, losing.id, t)
    .first<{ id: string; created_at: number; expires_at: number }>();
  let merge = open;
  if (!merge) {
    merge = { id: newUlid(t), created_at: t, expires_at: t + MERGE_PENDING_TTL_MS };
    await db
      .prepare(
        'INSERT INTO merges (id, kept_user_id, losing_user_id, identity_id, status, expires_at, created_at) ' +
          "VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)",
      )
      .bind(merge.id, kept.id, losing.id, identity.id, merge.expires_at, merge.created_at)
      .run();
    log.info('merge_pending_created', { mergeId: merge.id, provider: 'coinbase' });
    await enqueueSecurityNotice(env, other.id, 'merge_pending', t);
  }
  const view: Merge = {
    id: merge.id,
    status: 'pending',
    keptUserId: kept.id,
    losingUserId: losing.id,
    provider: 'coinbase',
    otherHandle: other.handle,
    createdAt: merge.created_at,
    expiresAt: merge.expires_at,
    confirmedAt: null,
  };
  return { status: 'merge_pending', merge: view };
}

/** The bind as one batch: user columns, the coinbase identity, and any tombstone inheritance. */
function bindStatements(
  db: D1Database,
  userId: string,
  personId: string,
  location: PersonLocation | null,
  firstBind: boolean,
  t: number,
): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(
        'UPDATE users SET person_id = ?2, kyc_status = ?3, person_verified_at = ?4, ' +
          'coinbase_country = ?5, coinbase_region = ?6 WHERE id = ?1',
      )
      .bind(
        userId,
        personId,
        location ? 'verified' : 'unverified',
        location ? t : null,
        location?.country ?? null,
        location?.region ?? null,
      ),
    db
      .prepare(
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'coinbase', ?3, ?4) " +
          'ON CONFLICT (provider, external_id) DO UPDATE SET verified_at = excluded.verified_at ' +
          'WHERE identities.user_id = excluded.user_id',
      )
      .bind(newUlid(t), userId, personId, t),
  ];
  if (firstBind) {
    // Inherit a deleted account's cap state (no-op without a tombstone). A lower cap always wins;
    // a cap from either side wins over none; a pending increase is kept with its original timer.
    statements.push(
      db
        .prepare(
          'INSERT INTO limits (user_id, daily_stake_cap, pending_cap, pending_cap_effective_at) ' +
            'SELECT ?1, daily_stake_cap, pending_cap, pending_cap_effective_at FROM person_tombstones WHERE person_id = ?2 ' +
            'ON CONFLICT (user_id) DO UPDATE SET ' +
            'daily_stake_cap = CASE WHEN limits.daily_stake_cap IS NULL THEN excluded.daily_stake_cap ' +
            'WHEN excluded.daily_stake_cap IS NULL THEN limits.daily_stake_cap ' +
            'ELSE min(limits.daily_stake_cap, excluded.daily_stake_cap) END, ' +
            'pending_cap = CASE WHEN limits.pending_cap IS NULL THEN excluded.pending_cap ELSE limits.pending_cap END, ' +
            'pending_cap_effective_at = CASE WHEN limits.pending_cap IS NULL THEN excluded.pending_cap_effective_at ' +
            'ELSE limits.pending_cap_effective_at END',
        )
        .bind(userId, personId),
      db.prepare('DELETE FROM person_tombstones WHERE person_id = ?1').bind(personId),
    );
  }
  return statements;
}

/**
 * Records the verification for `userId` (the OAuth state's user, never the request's cookie) and
 * reports the callback outcome.
 */
export async function applyVerification(
  env: PersonhoodEnv,
  userId: string,
  personId: string,
  location: PersonLocation | null,
  t: number,
): Promise<PersonhoodCallbackResponse> {
  const db = env.DB;
  const me = await account(db, 'id', userId);
  if (!me || (me.status !== 'active' && me.status !== 'suspended')) {
    return failed('account_unavailable');
  }
  if (me.person_id !== null && me.person_id !== personId) return failed('person_mismatch');

  const holder = me.person_id === personId ? me : await account(db, 'person_id', personId);
  if (holder && holder.id !== me.id) return pendingMerge(env, me, holder, personId, t);

  const firstBind = me.person_id === null;
  try {
    await db.batch(bindStatements(db, me.id, personId, location, firstBind, t));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed: users.person_id')) {
      // Another account bound the same person between our read and the batch.
      const winner = await account(db, 'person_id', personId);
      if (winner && winner.id !== me.id) return pendingMerge(env, me, winner, personId, t);
    }
    throw err;
  }
  log.info('personhood_bound', { userId: me.id, verified: location !== null, firstBind });
  if (firstBind) await enqueueSecurityNotice(env, me.id, 'identity_linked', t);
  if (!location) return failed('not_id_verified');
  return { status: 'verified', verifiedAt: t, country: location.country };
}
