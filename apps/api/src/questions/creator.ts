// The Stakes creator frozen at question lock (spec "Settlement and payout math": C goes to the creator
// address frozen at question lock; decision C5, Oct 12, 2026). The creator fee goes to the payout
// wallet the author chose in Settings only if, at lock:
//   - the author is verified, active (not suspended, merged or deleted) and not self-excluded;
//   - the wallet is a verified wallet identity linked to the author;
//   - its Verified Account and Verified Country attestations are unrevoked (re-read from the chain;
//     a failed read fails closed), the attested country is the author's Coinbase (OAuth) country,
//     and that country is on `geo.stakes.allow`;
//   - the author passed a request-location check when setting the wallet
//     (`prefs_json.creator_payout_location_ok_at`, the pass time).
// Otherwise the creator stays the draft config's (the treasury), as for house questions and room
// rounds. `creator` and `payoutAddress` are set together from one resolution (src/scheduler/lock.ts).
import { zeroAddress, type Address } from 'viem';
import { parsePrefs } from '../auth/profile.js';
import type { Env } from '../env.js';
import { excludedSql } from '../limits/rules.js';
import { userWalletAttestations } from '../personhood/attestations.js';
import { readStakesConfig } from '../personhood/config-store.js';
import { isVerified } from '../personhood/eligibility.js';
import { countryAllowed } from '../personhood/geo.js';
import type { QuestionRow } from '../scheduler/lock.js';

/**
 * The checks, in the order they run (the cheap D1 ones before the attestation reads); `failed` names
 * the first that failed.
 */
export const CREATOR_CHECKS = [
  'author_not_verified',
  'author_not_active',
  'author_self_excluded',
  'no_payout_wallet',
  'location_unchecked',
  'wallet_not_linked',
  'attestation_lookup_failed',
  'attestation_missing',
  'country_mismatch',
  'country_not_allowed',
] as const;
export type CreatorCheck = (typeof CREATOR_CHECKS)[number];

export interface CreatorResolution {
  /** The author's payout wallet (lowercase) when every check passed; null keeps the draft's creator. */
  creator: Address | null;
  /** Always `creator`: the two are set together. */
  payoutAddress: Address | null;
  /** The first check an author failed; null when they passed, or for a house question. */
  failed: CreatorCheck | null;
}

/** The draft's creator (the treasury) and no payout address. */
export const TREASURY_CREATOR: CreatorResolution = {
  creator: null,
  payoutAddress: null,
  failed: null,
};

const ADDRESS = /^0x[0-9a-f]{40}$/;

interface AuthorRow {
  status: string;
  person_id: string | null;
  kyc_status: string | null;
  coinbase_country: string | null;
  prefs_json: string;
  excluded: number;
}

/** The payout wallet (lowercase) and the location pass time from the author's prefs. */
function payoutPrefs(json: string): { wallet: Address | null; locationOkAt: number | null } {
  const prefs = parsePrefs(json) as Record<string, unknown>;
  const raw = prefs.creator_payout_wallet;
  const wallet = typeof raw === 'string' ? raw.toLowerCase() : null;
  const okAt = prefs.creator_payout_location_ok_at;
  return {
    wallet:
      wallet !== null && ADDRESS.test(wallet) && wallet !== zeroAddress
        ? (wallet as Address)
        : null,
    locationOkAt: typeof okAt === 'number' && Number.isFinite(okAt) ? okAt : null,
  };
}

async function check(
  env: Env,
  authorId: string,
  t: number,
): Promise<{ wallet: Address } | { failed: CreatorCheck }> {
  const db = env.DB;
  const row = await db
    .prepare(
      'SELECT status, person_id, kyc_status, coinbase_country, prefs_json, ' +
        `${excludedSql('?1', '?2')} AS excluded FROM users WHERE id = ?1`,
    )
    .bind(authorId, t)
    .first<AuthorRow>();
  if (!row || !isVerified(row)) return { failed: 'author_not_verified' };
  if (row.status !== 'active') return { failed: 'author_not_active' };
  if (row.excluded) return { failed: 'author_self_excluded' };

  const { wallet, locationOkAt } = payoutPrefs(row.prefs_json);
  if (wallet === null) return { failed: 'no_payout_wallet' };
  if (locationOkAt === null) return { failed: 'location_unchecked' };
  const linked = await db
    .prepare(
      "SELECT 1 FROM identities WHERE user_id = ?1 AND provider = 'wallet' AND external_id = ?2 " +
        'AND verified_at IS NOT NULL',
    )
    .bind(authorId, wallet)
    .first();
  if (!linked) return { failed: 'wallet_not_linked' };

  // Re-read now (no cache), as a ticket does: "unrevoked at lock".
  const [wallets, config] = await Promise.all([
    userWalletAttestations(env, authorId, t, 0),
    readStakesConfig(db),
  ]);
  const found = wallets.find((w) => w.wallet.toLowerCase() === wallet);
  if (!found) return { failed: 'wallet_not_linked' };
  const a = found.attestations;
  if (!a) return { failed: 'attestation_lookup_failed' };
  if (!a.verifiedAccount || !a.verifiedCountry || !a.country) {
    return { failed: 'attestation_missing' };
  }
  if (a.country !== row.coinbase_country) return { failed: 'country_mismatch' };
  if (!countryAllowed(config.geoAllow, a.country)) return { failed: 'country_not_allowed' };
  return { wallet };
}

/**
 * Who receives the Stakes creator fee of a daily round's question, resolved at its lock. A house
 * question resolves to the treasury with no failed check. Room rounds keep the draft's creator
 * without asking (decision C5); the lock never calls this for them.
 */
export async function resolveCreator(
  env: Env,
  q: Pick<QuestionRow, 'author_user_id'>,
  t: number,
): Promise<CreatorResolution> {
  if (q.author_user_id === null) return TREASURY_CREATOR;
  const result = await check(env, q.author_user_id, t);
  if ('failed' in result) return { ...TREASURY_CREATOR, failed: result.failed };
  return { creator: result.wallet, payoutAddress: result.wallet, failed: null };
}
