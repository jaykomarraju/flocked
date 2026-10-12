// Applies a completed Coinbase sign-in to the account that started it (spec "Identity and
// personhood" › Personhood, Merging accounts, Account deletion). What is stored: `person_id` (an
// HMAC), the country and region codes, `kyc_status`, and the coinbase identity (external_id =
// person_id). Nothing else from Coinbase reaches D1.
//
// - The person ID bound to another account: a pending merge (never a merge inside the callback;
//   the user confirms it with POST /me/merges/:id/confirm). Nothing is set on the caller's account.
// - The caller already bound to a different person ID: refused (`person_mismatch`).
// - A person tombstone for this ID (a deleted account of the same person): its daily cap state is
//   copied into the account's `limits`, the deleted account's Stakes tickets of today and later game
//   days move to this account, and the tombstone is deleted, in the same batch as the bind. The
//   stricter of two caps wins, and an inherited pending increase keeps its original timer.
// - No personal details: the person ID is still bound (so the Coinbase account cannot verify a
//   second account), with `kyc_status = 'unverified'` and no country, which is "not verified".
import { newUlid, type PersonhoodCallbackResponse } from '@flocked/shared';
import { enqueueSecurityNotice } from '../auth/accounts.js';
import { createPendingMerge } from '../identity/merge.js';
import { carryTicketsStatement } from '../identity/sql.js';
import { log } from '../lib/log.js';
import type { PersonLocation } from './coinbase.js';
import type { PersonhoodEnv } from './config.js';

/** A pending merge waits this long for confirmation (src/identity/merge.ts). */
export { MERGE_PENDING_TTL_MS } from '../identity/merge.js';

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
 * The pending merge between `me` and `other` (the account holding the person ID), through the
 * coinbase identity (src/identity/merge.ts; an open one between the same two accounts is reused).
 */
async function pendingMerge(
  env: PersonhoodEnv,
  me: AccountRow,
  other: AccountRow,
  personId: string,
  t: number,
): Promise<PersonhoodCallbackResponse> {
  const identity = await env.DB.prepare(
    "SELECT id FROM identities WHERE provider = 'coinbase' AND external_id = ?1",
  )
    .bind(personId)
    .first<{ id: string }>();
  if (!identity) {
    log.error('personhood_identity_missing', { userId: other.id });
    return failed('unavailable');
  }
  return {
    status: 'merge_pending',
    merge: await createPendingMerge(env, me, other, identity.id, t),
  };
}

/** SQL: the user (parameter `user`) holds the person ID (parameter `person`). */
const holds = (user: string, person: string) =>
  `EXISTS (SELECT 1 FROM users WHERE id = ${user} AND person_id = ${person})`;

/**
 * The bind as one batch: user columns, the coinbase identity, and any tombstone inheritance. The
 * user update applies only while the account holds no other person ID (a concurrent callback may
 * have bound one since our read), and the rest only once the account holds this one.
 */
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
          'coinbase_country = ?5, coinbase_region = ?6 WHERE id = ?1 AND (person_id IS NULL OR person_id = ?2)',
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
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) SELECT ?1, ?2, 'coinbase', ?3, ?4 " +
          `WHERE ${holds('?2', '?3')} ` +
          'ON CONFLICT (provider, external_id) DO UPDATE SET verified_at = excluded.verified_at ' +
          'WHERE identities.user_id = excluded.user_id',
      )
      .bind(newUlid(t), userId, personId, t),
  ];
  if (firstBind) {
    // Inherit a deleted account's cap state (no-op without a tombstone). A lower cap always wins;
    // a cap from either side wins over none; a pending increase is kept with its original timer,
    // unless the account's own cap is lower than the tombstone's (the raise would undo it).
    const inheritPending =
      'limits.pending_cap IS NULL AND ' +
      '(limits.daily_stake_cap IS NULL OR limits.daily_stake_cap >= excluded.daily_stake_cap)';
    statements.push(
      db
        .prepare(
          'INSERT INTO limits (user_id, daily_stake_cap, pending_cap, pending_cap_effective_at) ' +
            'SELECT ?1, daily_stake_cap, pending_cap, pending_cap_effective_at FROM person_tombstones ' +
            `WHERE person_id = ?2 AND ${holds('?1', '?2')} ` +
            'ON CONFLICT (user_id) DO UPDATE SET ' +
            'daily_stake_cap = CASE WHEN limits.daily_stake_cap IS NULL THEN excluded.daily_stake_cap ' +
            'WHEN excluded.daily_stake_cap IS NULL THEN limits.daily_stake_cap ' +
            'ELSE min(limits.daily_stake_cap, excluded.daily_stake_cap) END, ' +
            `pending_cap = CASE WHEN ${inheritPending} THEN excluded.pending_cap ELSE limits.pending_cap END, ` +
            `pending_cap_effective_at = CASE WHEN ${inheritPending} THEN excluded.pending_cap_effective_at ` +
            'ELSE limits.pending_cap_effective_at END',
        )
        .bind(userId, personId),
      // The deleted account's tickets of today and later game days count for this account, so
      // deleting and verifying again never restarts the day's cap at zero (W6-Z carry-over).
      carryTicketsStatement(
        db,
        {
          from: '(SELECT user_id FROM person_tombstones WHERE person_id = ?2)',
          to: '?1',
          where: holds('?1', '?2'),
        },
        t,
        userId,
        personId,
      ),
      db
        .prepare(`DELETE FROM person_tombstones WHERE person_id = ?1 AND ${holds('?2', '?1')}`)
        .bind(personId, userId),
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
    const [bound] = await db.batch(bindStatements(db, me.id, personId, location, firstBind, t));
    // A concurrent callback bound another person to this account since our read.
    if (bound?.meta.changes === 0) return failed('person_mismatch');
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
