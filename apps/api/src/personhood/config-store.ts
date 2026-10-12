// Reads of the admin-editable `config` table (migration 0009; W11-A edits it). Only the keys Stakes
// eligibility needs live here so far; a missing or malformed value reads as the safe default.
// `geo.stakes.age21` (W6-B) has the allow list's format; its values are the owner's (OA-21).
import { log } from '../lib/log.js';

export const CONFIG_KEYS = {
  geoStakesAllow: 'geo.stakes.allow',
  geoStakesAge21: 'geo.stakes.age21',
  stakesEnabled: 'mode.stakes.enabled',
} as const;

/** One `geo.stakes.allow` entry: a country, or one subdivision of it. */
export interface GeoRule {
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** ISO 3166-2 subdivision code without the country prefix, or null for the whole country. */
  region: string | null;
}

export interface StakesConfig {
  /** `geo.stakes.allow`: empty (the default) means Stakes is unavailable everywhere. */
  geoAllow: GeoRule[];
  /** `geo.stakes.age21`: the countries and regions that need 21+ (W6-B); empty means 18+ everywhere. */
  age21: GeoRule[];
  /** `mode.stakes.enabled`: false (the default) is the kill switch. */
  stakesEnabled: boolean;
}

const RULE = /^([A-Z]{2})(?:-([A-Z0-9]{1,3}))?$/;

/** Parses `geo.stakes.allow`: a JSON array of `"GB"` or `"US-NJ"`. Bad entries are dropped. */
export function parseGeoAllow(json: string | null): GeoRule[] {
  return parseGeoRules(json, CONFIG_KEYS.geoStakesAllow);
}

/** Parses a list of country and region codes (`geo.stakes.allow`, `geo.stakes.age21`). */
export function parseGeoRules(json: string | null, key: string): GeoRule[] {
  if (json === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    value = null;
  }
  if (!Array.isArray(value)) {
    log.warn('config_invalid', { key });
    return [];
  }
  const rules: GeoRule[] = [];
  for (const entry of value) {
    const m = typeof entry === 'string' ? RULE.exec(entry) : null;
    if (!m?.[1]) {
      log.warn('config_invalid_entry', { key });
      continue;
    }
    rules.push({ country: m[1], region: m[2] ?? null });
  }
  return rules;
}

export async function readStakesConfig(db: D1Database): Promise<StakesConfig> {
  const { results } = await db
    .prepare('SELECT key, value_json FROM config WHERE key IN (?1, ?2, ?3)')
    .bind(CONFIG_KEYS.geoStakesAllow, CONFIG_KEYS.geoStakesAge21, CONFIG_KEYS.stakesEnabled)
    .all<{ key: string; value_json: string }>();
  const value = (key: string) => results.find((r) => r.key === key)?.value_json ?? null;
  return {
    geoAllow: parseGeoAllow(value(CONFIG_KEYS.geoStakesAllow)),
    age21: parseGeoRules(value(CONFIG_KEYS.geoStakesAge21), CONFIG_KEYS.geoStakesAge21),
    stakesEnabled: value(CONFIG_KEYS.stakesEnabled) === 'true',
  };
}
