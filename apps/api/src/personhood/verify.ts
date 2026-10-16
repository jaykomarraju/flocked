// Applies a completed Coinbase sign-in to the account that started it (spec "Identity and
// personhood" › Personhood, Merging accounts, Account deletion). What is stored: `person_id` (an
// HMAC), the country and region codes, `kyc_status`, and the coinbase identity (external_id =
// person_id). Nothing else from Coinbase reaches D1.
//
// - A suspended account binds nothing (`account_suspended`; decision B7), and the bind applies only
//   while the account is active, so a bind racing `DELETE /me` or a suspension changes nothing.
// - The person ID bound to another account: a pending merge (never a merge inside the callback;
//   the user confirms it with POST /me/merges/:id/confirm). Nothing is set on the caller's account.
// - The caller already bound to a different person ID: refused (`person_mismatch`).
// - A person tombstone for this ID (a deleted account of the same person): its daily cap state is
//   copied into the account's `limits`, the deleted account's Stakes tickets of today and later game
//   days move to this account, and the tombstone is deleted, in the same batch as the bind. The cap
//   state follows the merge rule (`mergedCapState`): the lower cap in force, and only a pending
//   increase from that side, with its original timer (equal caps: the lower increase; a tie: the
//   later timer). Guards roll the batch back if the account's cap or the tombstone changed since
//   they were read.
// - No personal details: the person ID is still bound (so the Coinbase account cannot verify a
//   second account), with `kyc_status = 'unverified'` and no country, which is "not verified".
import { newUlid, type PersonhoodCallbackResponse } from '@flocked/shared';
import { enqueueSecurityNotice } from '../auth/accounts.js';
import {
  capStateUnchanged,
  createPendingMerge,
  mergedCapState,
  type LimitsCapRow,
} from '../identity/merge.js';
import { abortIf, carryTicketsStatement, isGuardAbort } from '../identity/sql.js';
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
  'account_suspended',
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

/** SQL: the user (parameter `user`), still active, holds the person ID (parameter `person`). */
const holds = (user: string, person: string) =>
  `EXISTS (SELECT 1 FROM users WHERE id = ${user} AND person_id = ${person} AND status = 'active')`;

interface TombstoneRow extends LimitsCapRow {
  user_id: string | null;
}

/** What a first bind inherits from: the account's cap columns and the person's tombstone. */
interface Inheritance {
  own: LimitsCapRow | null;
  tombstone: TombstoneRow | null;
}

async function readInheritance(
  db: D1Database,
  userId: string,
  personId: string,
): Promise<Inheritance> {
  const [own, tombstone] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT daily_stake_cap, pending_cap, pending_cap_effective_at FROM limits WHERE user_id = ?1',
      )
      .bind(userId),
    db
      .prepare(
        'SELECT daily_stake_cap, pending_cap, pending_cap_effective_at, user_id FROM person_tombstones WHERE person_id = ?1',
      )
      .bind(personId),
  ]);
  return {
    own: (own?.results[0] as LimitsCapRow | undefined) ?? null,
    tombstone: (tombstone?.results[0] as TombstoneRow | undefined) ?? null,
  };
}

/**
 * The bind as one batch: user columns, the coinbase identity, and (on a first bind, `inherit`) any
 * tombstone inheritance. The user update applies only while the account is active (a suspension or
 * `DELETE /me` may have landed since our read) and holds no other person ID (a concurrent callback
 * may have bound one), and the rest only once the active account holds this one.
 */
function bindStatements(
  db: D1Database,
  userId: string,
  personId: string,
  location: PersonLocation | null,
  inherit: Inheritance | null,
  t: number,
): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(
        'UPDATE users SET person_id = ?2, kyc_status = ?3, person_verified_at = ?4, ' +
          'coinbase_country = ?5, coinbase_region = ?6 ' +
          "WHERE id = ?1 AND status = 'active' AND (person_id IS NULL OR person_id = ?2)",
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
  if (inherit) {
    const { own, tombstone } = inherit;
    if (tombstone) {
      // Inherit the deleted account's cap state by the merge rule, from the rows as read: the
      // guards roll the whole bind back if either changed since.
      const cap = mergedCapState(own, tombstone, t);
      statements.push(
        capStateUnchanged(db, userId, own),
        abortIf(
          db,
          'NOT EXISTS (SELECT 1 FROM person_tombstones WHERE person_id = ?1 AND daily_stake_cap IS ?2 ' +
            'AND pending_cap IS ?3 AND pending_cap_effective_at IS ?4 AND user_id IS ?5)',
          personId,
          tombstone.daily_stake_cap,
          tombstone.pending_cap,
          tombstone.pending_cap_effective_at,
          tombstone.user_id,
        ),
        db
          .prepare(
            'INSERT INTO limits (user_id, daily_stake_cap, pending_cap, pending_cap_effective_at) ' +
              `SELECT ?1, ?3, ?4, ?5 WHERE ${holds('?1', '?2')} ` +
              'ON CONFLICT (user_id) DO UPDATE SET daily_stake_cap = excluded.daily_stake_cap, ' +
              'pending_cap = excluded.pending_cap, pending_cap_effective_at = excluded.pending_cap_effective_at',
          )
          .bind(
            userId,
            personId,
            cap.daily_stake_cap,
            cap.pending_cap,
            cap.pending_cap_effective_at,
          ),
      );
    }
    statements.push(
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
  // A suspended account starts no verification and no merge (decision B7).
  if (me.status === 'suspended') return failed('account_suspended');
  if (me.person_id !== null && me.person_id !== personId) return failed('person_mismatch');

  const holder = me.person_id === personId ? me : await account(db, 'person_id', personId);
  if (holder && holder.id !== me.id) return pendingMerge(env, me, holder, personId, t);

  const firstBind = me.person_id === null;
  const inherit = firstBind ? await readInheritance(db, me.id, personId) : null;
  try {
    const [bound] = await db.batch(bindStatements(db, me.id, personId, location, inherit, t));
    if (bound?.meta.changes === 0) {
      // Suspended or deleted since our read, or a concurrent callback bound another person.
      const now = await account(db, 'id', me.id);
      if (now?.status === 'suspended') return failed('account_suspended');
      if (now?.status !== 'active') return failed('account_unavailable');
      return failed('person_mismatch');
    }
  } catch (err) {
    if (isGuardAbort(err)) {
      // The account's cap or the person's tombstone changed since we read them: nothing bound.
      log.warn('personhood_bind_raced', { userId: me.id });
      return failed('unavailable');
    }
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
