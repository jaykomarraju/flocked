// The maximum daily stake cap (spec "Compliance and responsible play" › Responsible play; owner
// decision B4, Oct 12): the `config` key `limits.stakes.maxDailyCap`, in USDC base units, so legal
// (OA-21) can lower it. `PUT /me/limits` refuses a cap above it, `/prepare` never allows more than
// it, and `GET /me` reports it. Unset or invalid reads as 1,000 USDC; above 1,000 USDC reads as
// 1,000 USDC (the spec's upper bound).
import { DEFAULT_MAX_DAILY_STAKE_CAP, MAX_DAILY_STAKE_CAP_KEY } from '@flocked/shared';
import { log } from '../lib/log.js';

const DECIMAL = /^(0|[1-9][0-9]{0,30})$/;

/** The maximum from the key's `value_json` (a decimal string or a safe integer), or the default. */
export function parseMaxDailyCap(valueJson: string | null): bigint {
  if (valueJson === null) return DEFAULT_MAX_DAILY_STAKE_CAP;
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    value = null;
  }
  let cap: bigint | null = null;
  if (typeof value === 'string' && DECIMAL.test(value)) cap = BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) cap = BigInt(value);
  if (cap === null || cap > DEFAULT_MAX_DAILY_STAKE_CAP) {
    log.warn('config_invalid', { key: MAX_DAILY_STAKE_CAP_KEY });
    return DEFAULT_MAX_DAILY_STAKE_CAP;
  }
  return cap;
}

/** The statement that reads the key, for a caller's own batch (`parseMaxDailyCap` its row). */
export function maxDailyCapStatement(db: D1Database): D1PreparedStatement {
  return db.prepare('SELECT value_json FROM config WHERE key = ?1').bind(MAX_DAILY_STAKE_CAP_KEY);
}

/** The maximum daily stake cap in force (USDC base units). */
export async function readMaxDailyCap(db: D1Database): Promise<bigint> {
  const row = await maxDailyCapStatement(db).first<{ value_json: string }>();
  return parseMaxDailyCap(row?.value_json ?? null);
}
