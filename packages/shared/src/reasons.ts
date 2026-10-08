// VOID and refund reasons. VOID_REASONS, VoidReason and RefundReason live in @flocked/settle (it stays
// dependency-free); this module re-exports them and adds the refund-code table.
// Spec: "Settlement and payout math" › Refund rules, "Sealed picks" › Invalid entries.
import type { RefundReason } from '@flocked/settle';

export { VOID_REASONS } from '@flocked/settle';
export type { RefundReason, VoidReason } from '@flocked/settle';

/** Which modes a refund rule applies to. */
export type RefundScope = 'both' | 'free' | 'stakes';

export interface RefundReasonInfo {
  code: RefundReason;
  /** Stable snake_case name for logs, analytics and copy keys. */
  name: string;
  appliesTo: RefundScope;
  description: string;
}

/**
 * Refund codes 1–8 in table order. Rules 1–3 are checked in that order and the first that applies wins
 * (`settle` decides only these); 4–8 are lifecycle outcomes. Stakes stores the code onchain
 * (`RoundRefunded.reason`); both modes store it in `round_modes.refund_reason`.
 */
export const REFUND_REASONS = [
  {
    code: 1,
    name: 'too_few_entrants',
    appliesTo: 'both',
    description: 'Fewer than minEntrants valid entries (rooms: fewer than 3 qualifying entrants)',
  },
  {
    code: 2,
    name: 'one_sided',
    appliesTo: 'both',
    description: 'One-sided: an option has no valid entries',
  },
  {
    code: 3,
    name: 'headcount_tie',
    appliesTo: 'both',
    description: 'Headcount tie: N(A) = N(B)',
  },
  {
    code: 4,
    name: 'voided',
    appliesTo: 'both',
    description: 'Voided before closesAt by an admin (any mode) or the guardian (Stakes)',
  },
  {
    code: 5,
    name: 'vetoed',
    appliesTo: 'stakes',
    description: 'Guardian veto of a settlement proposal during the challenge window',
  },
  {
    code: 6,
    name: 'timeout',
    appliesTo: 'stakes',
    description: 'No outcome proposed within REFUND_TIMEOUT (72 hours) after close',
  },
  {
    code: 7,
    name: 'commitment_not_anchored',
    appliesTo: 'free',
    description: 'Commitment not anchored before the beacon',
  },
  {
    code: 8,
    name: 'beacon_unavailable',
    appliesTo: 'free',
    description: 'Beacon still unavailable 24 hours after its round time',
  },
] as const satisfies readonly RefundReasonInfo[];

export type RefundReasonName = (typeof REFUND_REASONS)[number]['name'];

/** The refund code list, 1–8. */
export const REFUND_REASON_CODES = REFUND_REASONS.map((r) => r.code) as readonly RefundReason[];

/** True for a refund code 1–8. */
export function isRefundReason(value: unknown): value is RefundReason {
  return typeof value === 'number' && (REFUND_REASON_CODES as readonly number[]).includes(value);
}

/** The table row for a refund code. */
export function refundReasonInfo(code: RefundReason): RefundReasonInfo {
  const info = REFUND_REASONS.find((r) => r.code === code);
  if (!info) throw new RangeError(`unknown refund reason ${String(code)}`);
  return info;
}
