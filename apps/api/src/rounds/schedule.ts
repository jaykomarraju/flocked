// The RoundDO alarm chain (spec "Real-time and the reveal" › RoundDO responsibilities; "Round
// lifecycle"; "Notifications" times). The DO has one alarm slot, so the chain is a fixed list of
// events, each run once in order; the alarm is always set for the earliest one not yet done.
import type { Mode } from '@flocked/shared';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** `streak_at_risk` goes out 3 hours before close, `closing_soon` 60 minutes before. */
export const STREAK_AT_RISK_LEAD_MS = 3 * HOUR_MS;
export const CLOSING_SOON_LEAD_MS = 60 * MINUTE_MS;
/** Free rule 8: the beacon still unavailable 24 hours after its round time. */
export const RULE8_AFTER_MS = 24 * HOUR_MS;

export type RoundEventKind =
  'open' | 'streak_at_risk' | 'closing_soon' | 'close' | 'settle' | 'rule8';

export interface RoundEvent {
  kind: RoundEventKind;
  /** Epoch ms. */
  at: number;
}

/** Ties (same `at`) run in this order. */
const ORDER: readonly RoundEventKind[] = [
  'open',
  'streak_at_risk',
  'closing_soon',
  'close',
  'settle',
  'rule8',
];

/**
 * The round's events: `opensAt` → open; the two notification times (only those after `opensAt`);
 * `closesAt` → close; beacon time → enqueue settlement for each mode; beacon time + 24 h → the
 * Free rule-8 check (Free rounds only).
 */
export function roundEvents(r: {
  opensAt: number;
  closesAt: number;
  beaconTimeSec: number;
  modes: readonly Mode[];
}): RoundEvent[] {
  const beaconAt = r.beaconTimeSec * 1000;
  const events: RoundEvent[] = [{ kind: 'open', at: r.opensAt }];
  for (const [kind, lead] of [
    ['streak_at_risk', STREAK_AT_RISK_LEAD_MS],
    ['closing_soon', CLOSING_SOON_LEAD_MS],
  ] as const) {
    if (r.closesAt - lead > r.opensAt) events.push({ kind, at: r.closesAt - lead });
  }
  events.push({ kind: 'close', at: r.closesAt }, { kind: 'settle', at: beaconAt });
  if (r.modes.includes('free')) events.push({ kind: 'rule8', at: beaconAt + RULE8_AFTER_MS });
  return events.sort((a, b) => a.at - b.at || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** The settle queue's idempotency key for a mode (plan P2.4: `${roundId}:${mode}`). */
export function settleKey(roundId: string, mode: Mode): string {
  return `${roundId}:${mode}`;
}

/**
 * The rule-8 job's key. It differs from the beacon-time job's, so the settle consumer runs it as its
 * own job: apply the conditional pending → refunded update (reason 8) and the refunds (W5-A).
 */
export function rule8Key(roundId: string): string {
  return `${roundId}:free:rule8`;
}
