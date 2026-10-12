// Stakes eligibility (wave-5 pinned interface; spec "Identity and personhood" › Personhood and Entry
// tickets, "Compliance and responsible play"). `GET /me` reports it; W6-B's ticket issue calls it
// with `{ attestationMaxAgeMs: 0 }` and adds the per-round checks (mode open, wallet linked, cap,
// no entry yet, room membership).
//
// Verified means `person_id` set and `kyc_status = verified`. The country check needs a verified
// wallet linked to the user that holds both Coinbase attestations (Verified Account and Verified
// Country), unrevoked, with the attested country equal to the Coinbase account's country from the
// OAuth callback. That country and the request location must both be on `geo.stakes.allow`.
//
// Age (W6-B): the attestation must name at least the age `geo.stakes.age21` requires for the
// verified country and the request location (src/personhood/age.ts); an 18+ attestation where 21+
// is required reads as `age_unattested`.
import { INELIGIBLE_REASONS, type IneligibleReason } from '@flocked/shared';
import { limitsView } from '../auth/profile.js';
import type { SessionUser } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { tosVersion } from '../auth/config.js';
import { ageAttestationCurrent, requiredAge, type AgeRequirement } from './age.js';
import { ATTESTATION_CACHE_MS, userWalletAttestations } from './attestations.js';
import type { PersonhoodEnv } from './config.js';
import { readStakesConfig } from './config-store.js';
import { countryAllowed, locationAllowed, proxySuspected, requestLocation } from './geo.js';

export interface StakesEligibility {
  eligible: boolean;
  /** Empty when eligible; in INELIGIBLE_REASONS order. */
  reasons: IneligibleReason[];
}

export interface EligibilityOptions {
  /** Accept cached attestation reads up to this old; 0 re-reads them (tickets). */
  attestationMaxAgeMs?: number;
}

interface EligibilityUserRow {
  status: SessionUser['status'];
  person_id: string | null;
  kyc_status: string | null;
  coinbase_country: string | null;
  age_attested_at: number | null;
  age_attested_min: number;
  tos_version: string | null;
}

/** Whether a user row counts as verified (one definition everywhere; spec "Personhood"). */
export function isVerified(row: { person_id: string | null; kyc_status: string | null }): boolean {
  return row.person_id !== null && row.kyc_status === 'verified';
}

/**
 * Why `user` may not play Stakes from `request`'s location now. The user row is re-read, so a
 * session's cached view of verification never decides it.
 */
export async function stakesEligibility(
  env: PersonhoodEnv,
  user: Pick<SessionUser, 'id'>,
  request: Request,
  opts: EligibilityOptions = {},
): Promise<StakesEligibility> {
  const db = env.DB;
  const t = now(env);
  const [row, limits, config] = await Promise.all([
    db
      .prepare(
        'SELECT status, person_id, kyc_status, coinbase_country, age_attested_at, age_attested_min, ' +
          'tos_version FROM users WHERE id = ?1',
      )
      .bind(user.id)
      .first<EligibilityUserRow>(),
    db.prepare('SELECT * FROM limits WHERE user_id = ?1').bind(user.id).first(),
    readStakesConfig(db),
  ]);
  const reasons = new Set<IneligibleReason>();
  if (!row) return { eligible: false, reasons: ['not_verified'] };

  const verified = isVerified(row);
  if (!verified) {
    reasons.add('not_verified');
  } else {
    const oauthCountry = row.coinbase_country;
    const wallets = await userWalletAttestations(
      env,
      user.id,
      t,
      opts.attestationMaxAgeMs ?? ATTESTATION_CACHE_MS,
    );
    const attested = wallets
      .map((w) => w.attestations)
      .filter((a) => a?.verifiedAccount && a.verifiedCountry && a.country)
      .map((a) => a?.country);
    if (attested.length === 0) {
      reasons.add('country_unverified');
    } else if (!oauthCountry || !attested.includes(oauthCountry)) {
      reasons.add('country_mismatch');
    } else if (!countryAllowed(config.geoAllow, oauthCountry)) {
      reasons.add('geo_blocked');
    }
  }
  if (!locationAllowed(config.geoAllow, requestLocation(request))) reasons.add('geo_blocked');
  if (proxySuspected(request)) reasons.add('proxy_detected');
  const age = requiredAge(config.age21, verifiedCountryOf(row), requestLocation(request));
  if (!ageAttestationCurrent(row, age)) reasons.add('age_unattested');
  if (row.tos_version !== tosVersion(env)) reasons.add('tos_not_accepted');
  if (limitsView(limits as Parameters<typeof limitsView>[0], t).excluded) {
    reasons.add('self_excluded');
  }
  if (row.status !== 'active') reasons.add('suspended');
  if (!config.stakesEnabled) reasons.add('stakes_disabled');

  const ordered = INELIGIBLE_REASONS.filter((r) => reasons.has(r));
  return { eligible: ordered.length === 0, reasons: ordered };
}

/** The Coinbase country of a verified user (the age rule's "verified country"), else null. */
function verifiedCountryOf(row: {
  person_id: string | null;
  kyc_status: string | null;
  coinbase_country: string | null;
}): string | null {
  return isVerified(row) ? row.coinbase_country : null;
}

/**
 * The age the Stakes age checkbox names for `userId` at `request`'s location (`TosState.ageRequired`)
 * and that `POST /me/tos` records: 21 where `geo.stakes.age21` lists the verified country or the
 * request location, else 18.
 */
export async function stakesAgeRequirement(
  env: PersonhoodEnv,
  userId: string,
  request: Request,
): Promise<AgeRequirement> {
  const [row, config] = await Promise.all([
    env.DB.prepare('SELECT person_id, kyc_status, coinbase_country FROM users WHERE id = ?1')
      .bind(userId)
      .first<{
        person_id: string | null;
        kyc_status: string | null;
        coinbase_country: string | null;
      }>(),
    readStakesConfig(env.DB),
  ]);
  return requiredAge(config.age21, row ? verifiedCountryOf(row) : null, requestLocation(request));
}
