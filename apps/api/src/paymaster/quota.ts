// Ten successful final sponsorships per smart-wallet sender and UTC day. Pending leases reserve a
// slot so parallel requests cannot all pass a count-then-insert race; only the current lease token
// can commit or release its row.
import { encodePacked, keccak256, type Address, type Hex } from 'viem';
import type { PaymasterUserOperation } from './policy.js';

export const DAILY_SPONSORSHIP_CAP = 10;
export const SPONSORSHIP_LEASE_MS = 30_000;

export function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function sponsorshipKey(input: { chainId: bigint; userOp: PaymasterUserOperation }): Hex {
  return keccak256(
    encodePacked(
      ['uint256', 'address', 'uint256'],
      [input.chainId, input.userOp.sender, BigInt(input.userOp.nonce)],
    ),
  );
}

interface SponsorshipRow {
  status: 'pending' | 'succeeded';
  lease_token: string;
  lease_expires_at: number;
  result_json: string | null;
}

export type LeaseResult =
  | { kind: 'acquired'; key: Hex; token: string }
  | { kind: 'replay'; result: Record<string, unknown> }
  | { kind: 'pending' }
  | { kind: 'cap' };

/** One atomic write admits this operation or replaces its expired lease. */
export async function acquireSponsorship(
  db: D1Database,
  input: { key: Hex; sender: Address; now: number },
): Promise<LeaseResult> {
  const day = utcDay(input.now);
  const token = crypto.randomUUID();
  const expires = input.now + SPONSORSHIP_LEASE_MS;
  await db
    .prepare(
      'INSERT INTO paymaster_sponsorships ' +
        '(operation_key, sender, utc_day, status, lease_token, lease_expires_at, result_json, created_at, updated_at, succeeded_at) ' +
        "SELECT ?1, ?2, ?3, 'pending', ?4, ?5, NULL, ?6, ?6, NULL " +
        'WHERE (SELECT COUNT(*) FROM paymaster_sponsorships WHERE sender = ?2 AND utc_day = ?3 ' +
        "AND (status = 'succeeded' OR (status = 'pending' AND lease_expires_at > ?6))) < ?7 " +
        'ON CONFLICT(operation_key) DO UPDATE SET utc_day = excluded.utc_day, status = excluded.status, ' +
        'lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at, ' +
        'result_json = NULL, updated_at = excluded.updated_at, succeeded_at = NULL ' +
        "WHERE paymaster_sponsorships.status = 'pending' AND paymaster_sponsorships.lease_expires_at <= ?6",
    )
    .bind(input.key, input.sender, day, token, expires, input.now, DAILY_SPONSORSHIP_CAP)
    .run();

  const row = await db
    .prepare(
      'SELECT status, lease_token, lease_expires_at, result_json FROM paymaster_sponsorships WHERE operation_key = ?1',
    )
    .bind(input.key)
    .first<SponsorshipRow>();
  if (!row) return { kind: 'cap' };
  if (row.status === 'succeeded') {
    try {
      const result = JSON.parse(row.result_json ?? 'null') as unknown;
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return { kind: 'replay', result: result as Record<string, unknown> };
      }
    } catch {
      // A corrupt retained response is not safe to return or overwrite as a fresh sponsorship.
    }
    return { kind: 'pending' };
  }
  if (row.lease_token === token) return { kind: 'acquired', key: input.key, token };
  return { kind: 'pending' };
}

/** Stores only a successful provider result. A stale lease owner changes nothing. */
export async function commitSponsorship(
  db: D1Database,
  lease: Extract<LeaseResult, { kind: 'acquired' }>,
  result: Record<string, unknown>,
  at: number,
): Promise<boolean> {
  const written = await db
    .prepare(
      "UPDATE paymaster_sponsorships SET status = 'succeeded', result_json = ?3, " +
        'lease_expires_at = ?4, updated_at = ?4, succeeded_at = ?4 ' +
        "WHERE operation_key = ?1 AND lease_token = ?2 AND status = 'pending'",
    )
    .bind(lease.key, lease.token, JSON.stringify(result), at)
    .run();
  return written.meta.changes === 1;
}

/** Provider errors and transport failures do not consume the cap. */
export async function releaseSponsorship(
  db: D1Database,
  lease: Extract<LeaseResult, { kind: 'acquired' }>,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM paymaster_sponsorships WHERE operation_key = ?1 AND lease_token = ?2 AND status = 'pending'",
    )
    .bind(lease.key, lease.token)
    .run();
}
