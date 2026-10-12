// The Stakes age requirement (spec "Compliance and responsible play" › Age and terms; W5-Z carry-over):
// 18+, or 21+ where `geo.stakes.age21` lists the place. Two places are checked, as for geo-fencing:
//   * the verified country, at country level: a whole-country entry ("XX") names it. A region entry
//     ("US-MS") does not, because region rules apply to the request location only (Decision log,
//     Oct 12, 2026);
//   * the request location: a whole-country entry for its country, or the entry for its region.
//     A request with no region code needs 21 when any entry names a region of its country (O3,
//     Oct 12, 2026): the region it may be in can't be ruled out.
// The Stakes sheet's age checkbox names this age, `POST /me/tos` records an attestation of it
// (`users.age_attested_min`, migration 0012), and an attestation of a lower age doesn't count.
import type { GeoRule } from './config-store.js';
import type { RequestLocation } from './geo.js';

export type AgeRequirement = 18 | 21;

/** The age the user must attest: 21 when the verified country or the request location is listed. */
export function requiredAge(
  age21: GeoRule[],
  verifiedCountry: string | null,
  loc: RequestLocation,
): AgeRequirement {
  const country =
    verifiedCountry !== null &&
    age21.some((r) => r.country === verifiedCountry && r.region === null);
  const location =
    loc.country !== null &&
    age21.some(
      (r) =>
        r.country === loc.country &&
        (r.region === null || loc.region === null || r.region === loc.region),
    );
  return country || location ? 21 : 18;
}

/** True when the user has attested at least `required` (and has attested at all). */
export function ageAttestationCurrent(
  row: { age_attested_at: number | null; age_attested_min: number },
  required: AgeRequirement,
): boolean {
  return row.age_attested_at !== null && row.age_attested_min >= required;
}
