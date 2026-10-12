// Linking and unlinking identities (spec "Identity and personhood" › Identities). A signed-in user
// links another identity by proving control of it (src/identity/proof.ts). An identity another
// account holds, verified, creates a pending merge instead (src/identity/merge.ts). An unverified
// row (a wallet offered from the user's Farcaster account, never proven) belongs to nobody: it is
// released to whoever proves control, and never blocks sign-in or linking (W3-Z carry-over).
import { getAddress, isAddress } from 'viem';
import { newUlid, type LinkResult } from '@flocked/shared';
import { enqueueSecurityNotice } from '../auth/accounts.js';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { identityView, loadAccount, type AccountRow, type IdentityRow } from './accounts.js';
import { createPendingMerge } from './merge.js';
import { dismissOfferStatement } from './offers.js';
import type { ProvenIdentity } from './proof.js';

const IDENTITY_COLUMNS = 'id, user_id, provider, external_id, verified_at';

/** Sign-in-capable providers (spec: wallet, Farcaster or verified email). */
const SIGN_IN_SQL = "provider IN ('wallet', 'farcaster', 'email') AND verified_at IS NOT NULL";

async function identityByExternal(
  db: D1Database,
  provider: string,
  externalId: string,
): Promise<IdentityRow | null> {
  return db
    .prepare(`SELECT ${IDENTITY_COLUMNS} FROM identities WHERE provider = ?1 AND external_id = ?2`)
    .bind(provider, externalId)
    .first<IdentityRow>();
}

/**
 * Links the proven identity to `me`. Answers `linked` (also when it already was), or
 * `merge_pending` when another live account holds it verified.
 */
export async function linkIdentity(
  env: Env,
  me: AccountRow,
  proven: ProvenIdentity,
  t: number,
): Promise<LinkResult> {
  const db = env.DB;
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await identityByExternal(db, proven.provider, proven.externalId);
    if (existing && existing.verified_at !== null && existing.user_id !== me.id) {
      const holder = await loadAccount(db, existing.user_id);
      if (holder && (holder.status === 'active' || holder.status === 'suspended')) {
        return {
          status: 'merge_pending',
          merge: await createPendingMerge(env, me, holder, existing.id, t),
        };
      }
      // A row left on a merged or deleted account signs in to nothing: release it below.
    }
    if (existing?.user_id === me.id && existing.verified_at !== null) {
      return { status: 'linked', identity: identityView(existing) };
    }

    const id = existing?.user_id === me.id ? existing.id : newUlid(t);
    const statements = [
      // Release an unverified (or orphaned) row held elsewhere; ours is verified in place.
      db
        .prepare(
          'DELETE FROM identities WHERE provider = ?1 AND external_id = ?2 AND user_id <> ?3 AND ' +
            '(verified_at IS NULL OR user_id NOT IN (SELECT id FROM users WHERE status IN (?4, ?5)))',
        )
        .bind(proven.provider, proven.externalId, me.id, 'active', 'suspended'),
      db
        .prepare(
          'INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, ?3, ?4, ?5) ' +
            'ON CONFLICT (provider, external_id) DO UPDATE SET verified_at = excluded.verified_at ' +
            'WHERE identities.user_id = excluded.user_id',
        )
        .bind(id, me.id, proven.provider, proven.externalId, t),
    ];
    await db.batch(statements);
    const row = await identityByExternal(db, proven.provider, proven.externalId);
    if (row?.user_id === me.id && row.verified_at !== null) {
      log.info('identity_linked', { userId: me.id, provider: proven.provider });
      await enqueueSecurityNotice(env, me.id, 'identity_linked', t);
      return { status: 'linked', identity: identityView(row) };
    }
    // Another account proved it between our read and the batch: go round once more.
  }
  throw new HttpError('conflict', 'This identity changed while linking; try again');
}

/**
 * Unlinks `identityId` from `userId` (spec "Identity and personhood" › Identities): never the last
 * sign-in identity, never the coinbase identity once a person ID is bound (only deletion removes
 * it), and never a wallet with Stakes entries in a round that isn't final or unclaimed payouts.
 * An unverified (offered) row can always be dismissed.
 */
export async function unlinkIdentity(env: Env, userId: string, identityId: string, t: number) {
  const db = env.DB;
  const row = await db
    .prepare(`SELECT ${IDENTITY_COLUMNS} FROM identities WHERE id = ?1 AND user_id = ?2`)
    .bind(identityId, userId)
    .first<IdentityRow>();
  if (!row) throw new HttpError('not_found', 'No such identity');
  if (row.provider === 'coinbase') {
    throw new HttpError(
      'identity_locked',
      'The Coinbase verification stays with the account; deleting the account removes it',
    );
  }
  if (row.verified_at !== null && row.provider === 'wallet') await refuseLockedWallet(db, row);

  // The last-sign-in rule is part of the DELETE, so two concurrent unlinks can't both pass it. A
  // dismissed Farcaster offer is remembered, so it isn't offered again.
  const statements = [
    db
      .prepare(
        'DELETE FROM identities WHERE id = ?1 AND user_id = ?2 AND (verified_at IS NULL OR ' +
          `(SELECT count(*) FROM identities WHERE user_id = ?2 AND id <> ?1 AND ${SIGN_IN_SQL}) > 0)`,
      )
      .bind(identityId, userId),
  ];
  if (row.verified_at === null && row.provider === 'wallet') {
    statements.push(dismissOfferStatement(db, userId, row.external_id));
  }
  const [result] = await db.batch(statements);
  if (result?.meta.changes === 0) {
    throw new HttpError(
      'identity_required',
      'Link another way to sign in (a wallet, Farcaster or a verified email) before removing this one',
    );
  }
  log.info('identity_unlinked', { userId, provider: row.provider, at: t });
}

/** A wallet with Stakes entries in a round that isn't final, or unclaimed Stakes payouts. */
async function refuseLockedWallet(db: D1Database, row: IdentityRow): Promise<void> {
  const lower = row.external_id.toLowerCase();
  const forms = isAddress(lower) ? [lower, getAddress(lower)] : [lower, lower];
  const locked = await db
    .prepare(
      'SELECT EXISTS (SELECT 1 FROM entries e JOIN round_modes rm ON rm.round_id = e.round_id AND rm.mode = e.mode ' +
        "WHERE e.mode = 'stakes' AND e.wallet IN (?1, ?2) AND rm.status NOT IN ('settled', 'refunded', 'voided')) " +
        "OR EXISTS (SELECT 1 FROM payouts WHERE mode = 'stakes' AND wallet = ?1 AND claimed_at IS NULL AND amount > 0) " +
        'AS locked',
    )
    .bind(forms[0], forms[1])
    .first<{ locked: number }>();
  if (locked?.locked === 1) {
    throw new HttpError(
      'identity_locked',
      'This wallet has Stakes entries in a round that is not final, or unclaimed payouts',
    );
  }
}
