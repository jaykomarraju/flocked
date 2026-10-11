// Geo-fencing (spec "Compliance and responsible play" › Geo-fencing). Two locations must be on
// `geo.stakes.allow`: the user's Coinbase Verified Country (country-level: allowed when any rule
// names that country), and the request location from `request.cf` (a whole-country rule, or a
// subdivision rule matching `regionCode`). An unknown request location is not allowed.
//
// VPN/proxy signals (spec: "bot management score and known-proxy flags where available"):
// Cloudflare reports Tor exits as country `T1`, and Bot Management (when the zone has it) a score
// where 1-29 means likely automated. Workers get no generic VPN flag; that gap is a W5-B spec issue.
import type { GeoRule } from './config-store.js';

/** Bot Management scores below this count as a proxy signal (Cloudflare: 1-29 = likely automated). */
export const BOT_SCORE_MIN = 30;

export interface RequestLocation {
  country: string | null;
  region: string | null;
}

interface CfGeo {
  country?: unknown;
  regionCode?: unknown;
  botManagement?: { score?: unknown; verifiedBot?: unknown };
}

function cfOf(request: Request): CfGeo {
  return (request as { cf?: CfGeo }).cf ?? {};
}

/** `request.cf.country` / `regionCode`; Tor (`T1`) and unknown (`XX`) have no location. */
export function requestLocation(request: Request): RequestLocation {
  const cf = cfOf(request);
  const country = typeof cf.country === 'string' ? cf.country.toUpperCase() : null;
  const region = typeof cf.regionCode === 'string' ? cf.regionCode.toUpperCase() : null;
  if (!country || !/^[A-Z]{2}$/.test(country) || country === 'T1' || country === 'XX') {
    return { country: null, region: null };
  }
  return { country, region: region && /^[A-Z0-9]{1,3}$/.test(region) ? region : null };
}

/** True when Cloudflare flags the request as coming through Tor or as likely automated. */
export function proxySuspected(request: Request): boolean {
  const cf = cfOf(request);
  if (cf.country === 'T1') return true;
  const score = cf.botManagement?.score;
  return typeof score === 'number' && score > 0 && score < BOT_SCORE_MIN;
}

/** The verified country is allowed when any rule names it (a region rule allows its country). */
export function countryAllowed(rules: GeoRule[], country: string): boolean {
  return rules.some((r) => r.country === country);
}

/** The request location is allowed by a whole-country rule or the matching subdivision rule. */
export function locationAllowed(rules: GeoRule[], loc: RequestLocation): boolean {
  if (!loc.country) return false;
  return rules.some(
    (r) => r.country === loc.country && (r.region === null || r.region === loc.region),
  );
}
