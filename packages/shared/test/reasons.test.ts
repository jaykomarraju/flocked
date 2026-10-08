import { VOID_REASONS as SETTLE_VOID_REASONS } from '@flocked/settle';
import { describe, expect, it } from 'vitest';

import {
  isRefundReason,
  REFUND_REASON_CODES,
  REFUND_REASONS,
  refundReasonInfo,
  VOID_REASONS,
} from '../src/reasons';

// Values copied from Product_Spec.md ("Settlement and payout math" › Refund rules). Changing one here needs
// a spec change first.
describe('refund reasons', () => {
  it('are codes 1–8 in table order with the spec scopes', () => {
    expect(REFUND_REASONS.map((r) => [r.code, r.appliesTo])).toEqual([
      [1, 'both'],
      [2, 'both'],
      [3, 'both'],
      [4, 'both'],
      [5, 'stakes'],
      [6, 'stakes'],
      [7, 'free'],
      [8, 'free'],
    ]);
    expect(REFUND_REASON_CODES).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('have unique snake_case names that do not reuse a VOID reason', () => {
    const names = REFUND_REASONS.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(VOID_REASONS).not.toContain(n);
    }
  });

  it('isRefundReason and refundReasonInfo', () => {
    expect(isRefundReason(1)).toBe(true);
    expect(isRefundReason(8)).toBe(true);
    expect(isRefundReason(0)).toBe(false);
    expect(isRefundReason(9)).toBe(false);
    expect(isRefundReason('1')).toBe(false);
    expect(refundReasonInfo(7).name).toBe('commitment_not_anchored');
    expect(() => refundReasonInfo(9 as 1)).toThrow(RangeError);
  });
});

describe('VOID reasons', () => {
  it('re-export @flocked/settle', () => {
    expect(VOID_REASONS).toBe(SETTLE_VOID_REASONS);
  });
});
