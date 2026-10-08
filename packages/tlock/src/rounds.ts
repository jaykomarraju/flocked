// Beacon math and the client's target-round check (spec: "Sealed picks", "Round lifecycle" › Scheduling).
import type { DrandChain } from './chains.js';

/** Seconds; the same bounds as FlockedEscrow and FlockedAnchor. */
export const MIN_BEACON_DELAY = 60;
export const MAX_BEACON_DELAY = 600;

/**
 * Why `checkTargetRound` refused. Checks run in this order and the first failure is reported:
 * - `invalid_round`: `beaconRound` < 1 (the contract reverts `InvalidBeaconRound`);
 * - `beacon_too_early` / `beacon_too_late`: beacon time outside
 *   `[closesAt + MIN_BEACON_DELAY, closesAt + MAX_BEACON_DELAY]` (the contract reverts `BeaconOutOfRange`);
 * - `invalid_delay`: `beaconDelay` outside `[MIN_BEACON_DELAY, MAX_BEACON_DELAY]`;
 * - `not_first_round`: `beaconRound` is not the first round at or after `closesAt + beaconDelay`;
 * - `beacon_in_past`: the beacon time is not after `now`;
 * - `wrong_daily_close`: `closesAt` is not 21:00 America/New_York on `dailyClose.gameDay`.
 * The first three are exactly the contract's `createRound` beacon rule; the rest are client-only.
 */
export const TARGET_ROUND_ERRORS = [
  'invalid_round',
  'beacon_too_early',
  'beacon_too_late',
  'invalid_delay',
  'not_first_round',
  'beacon_in_past',
  'wrong_daily_close',
] as const;
export type TargetRoundError = (typeof TARGET_ROUND_ERRORS)[number];

function assertTime(name: string, t: number): void {
  if (!Number.isSafeInteger(t) || t < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

/** Unix seconds of `round`: genesis + (round − 1) × period. Throws for round < 1, like the contract. */
export function beaconTime(chain: DrandChain, round: number): number {
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new RangeError('round must be an integer ≥ 1');
  }
  const t = chain.genesis + (round - 1) * chain.period;
  if (!Number.isSafeInteger(t)) throw new RangeError('beacon time overflows');
  return t;
}

/** The first round whose time is at or after `t` (round 1 for any `t` up to genesis). */
export function firstRoundAtOrAfter(chain: DrandChain, t: number): number {
  assertTime('t', t);
  if (t <= chain.genesis) return 1;
  const d = t - chain.genesis;
  // ceil(d / period) in exact integer arithmetic.
  let q = Math.floor(d / chain.period);
  while (q * chain.period < d) q += 1;
  while (q > 0 && (q - 1) * chain.period >= d) q -= 1;
  return q + 1;
}

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** True when `closesAt` (Unix seconds) is exactly 21:00:00 America/New_York on `gameDay` (YYYY-MM-DD). */
export function isDailyClose(closesAt: number, gameDay: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDay)) return false;
  const p: Record<string, string> = {};
  for (const { type, value } of NY_PARTS.formatToParts(new Date(closesAt * 1000))) p[type] = value;
  return (
    `${p.year}-${p.month}-${p.day}` === gameDay &&
    p.hour === '21' &&
    p.minute === '00' &&
    p.second === '00'
  );
}

export function checkTargetRound(i: {
  chain: DrandChain;
  closesAt: number;
  beaconDelay: number;
  beaconRound: number;
  now: number;
  dailyClose?: { gameDay: string };
}): { ok: true } | { ok: false; reason: TargetRoundError } {
  const { chain, closesAt, beaconDelay, beaconRound, now } = i;
  assertTime('closesAt', closesAt);
  assertTime('now', now);
  const fail = (reason: TargetRoundError) => ({ ok: false as const, reason });

  if (!Number.isSafeInteger(beaconRound) || beaconRound < 1) return fail('invalid_round');
  const bt = beaconTime(chain, beaconRound);
  if (bt < closesAt + MIN_BEACON_DELAY) return fail('beacon_too_early');
  if (bt > closesAt + MAX_BEACON_DELAY) return fail('beacon_too_late');
  if (
    !Number.isSafeInteger(beaconDelay) ||
    beaconDelay < MIN_BEACON_DELAY ||
    beaconDelay > MAX_BEACON_DELAY
  ) {
    return fail('invalid_delay');
  }
  if (beaconRound !== firstRoundAtOrAfter(chain, closesAt + beaconDelay)) {
    return fail('not_first_round');
  }
  if (bt <= now) return fail('beacon_in_past');
  if (i.dailyClose && !isDailyClose(closesAt, i.dailyClose.gameDay)) {
    return fail('wrong_daily_close');
  }
  return { ok: true };
}
