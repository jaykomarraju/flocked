// Responsible-play rules (spec "Compliance and responsible play" › Responsible play; "Data model"
// `limits`). Excluded means `self_exclusion_until` > now, or permanent and not yet lifted
// (`exclusion_lift_effective_at` unset or in the future); `excludedSql` is that rule in SQL and
// src/auth/profile.ts `limitsView` the same rule in TypeScript (test/limits/rules.test.ts checks
// they agree).
import type { SelfExclusionPeriod } from '@flocked/shared';

export const HOUR_MS = 3600 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** A raised cap waits this long (spec: 24 hours). */
export const CAP_RAISE_DELAY_MS = 24 * HOUR_MS;
/** A permanent exclusion can be lifted on request this many months after it started. */
export const EXCLUSION_LIFT_AFTER_MONTHS = 6;
/** ...and the lift takes effect after this cooling-off period. */
export const EXCLUSION_LIFT_COOLING_OFF_MS = 7 * DAY_MS;

/** `t` plus `months` calendar months (UTC); a day past the month's end clamps to its last day. */
export function addMonths(t: number, months: number): number {
  const d = new Date(t);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/** When a timed exclusion of `period` that starts at `t` ends; null for permanent. */
export function exclusionUntil(period: SelfExclusionPeriod, t: number): number | null {
  switch (period) {
    case '7d':
      return t + 7 * DAY_MS;
    case '30d':
      return t + 30 * DAY_MS;
    case '6m':
      return addMonths(t, 6);
    case 'permanent':
      return null;
  }
}

/** SQL: user `userSql` is self-excluded at `tSql` (epoch ms). */
export function excludedSql(userSql: string, tSql: string): string {
  return (
    `EXISTS (SELECT 1 FROM limits l WHERE l.user_id = ${userSql} AND ` +
    `((l.self_exclusion_until IS NOT NULL AND l.self_exclusion_until > ${tSql}) OR ` +
    `(l.self_exclusion_permanent = 1 AND (l.exclusion_lift_effective_at IS NULL OR ` +
    `l.exclusion_lift_effective_at > ${tSql}))))`
  );
}
