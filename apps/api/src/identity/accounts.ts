// The account rows identity code works from, and the identity views it answers with.
import type { Identity, Merge } from '@flocked/shared';
import type { SessionUser } from '../lib/auth-context.js';
import { HttpError } from '../lib/errors.js';

export interface AccountRow {
  id: string;
  status: SessionUser['status'];
  merged_into: string | null;
  handle: string | null;
  person_id: string | null;
  kyc_status: string | null;
  person_verified_at: number | null;
  coinbase_country: string | null;
  coinbase_region: string | null;
  created_at: number;
}

const ACCOUNT_COLUMNS =
  'id, status, merged_into, handle, person_id, kyc_status, person_verified_at, coinbase_country, ' +
  'coinbase_region, created_at';

export async function loadAccount(db: D1Database, id: string): Promise<AccountRow | null> {
  return db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?1`)
    .bind(id)
    .first<AccountRow>();
}

/** The caller's own account; 401 if it vanished under the session. */
export async function loadCaller(db: D1Database, id: string): Promise<AccountRow> {
  const row = await loadAccount(db, id);
  if (!row) throw new HttpError('unauthorized', 'Sign in required');
  return row;
}

/** Suspended accounts sign in read-only (spec "Identity and personhood" › Identities). */
export function refuseSuspended(row: { status: string }): void {
  if (row.status === 'suspended') {
    throw new HttpError('account_suspended', 'This account is suspended');
  }
}

/** The kept account of two is the one created first (spec "Merging accounts"); ties by ID. */
export function keptFirst<T extends { id: string; created_at: number }>(a: T, b: T): [T, T] {
  const aFirst = a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);
  return aFirst ? [a, b] : [b, a];
}

export interface IdentityRow {
  id: string;
  user_id: string;
  provider: Identity['provider'];
  external_id: string;
  verified_at: number | null;
}

/** The API view of an identity: a coinbase identity's external ID (the person ID) never leaves. */
export function identityView(r: IdentityRow): Identity {
  return {
    id: r.id,
    provider: r.provider,
    externalId: r.provider === 'coinbase' ? null : r.external_id,
    verifiedAt: r.verified_at,
  };
}

export interface MergeRow {
  id: string;
  kept_user_id: string;
  losing_user_id: string;
  identity_id: string;
  status: Merge['status'];
  expires_at: number;
  created_at: number;
  confirmed_at: number | null;
}

export function mergeView(
  m: MergeRow,
  provider: Merge['provider'],
  otherHandle: string | null,
): Merge {
  return {
    id: m.id,
    status: m.status,
    keptUserId: m.kept_user_id,
    losingUserId: m.losing_user_id,
    provider,
    otherHandle,
    createdAt: m.created_at,
    expiresAt: m.expires_at,
    confirmedAt: m.confirmed_at,
  };
}
