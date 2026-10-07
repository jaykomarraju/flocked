import { describe, expect, it } from 'vitest';
import type { EntryInput } from '../src/index.js';
import { VOID_REASONS, checkInvariant, settle } from '../src/index.js';
import {
  FREE_DEFAULTS,
  STAKES_DEFAULTS,
  USDC,
  addr,
  fixedRound,
  valid,
  voided,
} from './helpers.js';

describe('SET-4 VOID entries are excluded from tallies and refunded', () => {
  it.each(VOID_REASONS)('%s: excluded and refunded in a settled Stakes round', (reason) => {
    const s = 5n * USDC;
    const base = fixedRound(s, 8, 12);
    const withVoid = [...base, voided(100, s, reason)];
    const a = settle(base, STAKES_DEFAULTS);
    const b = settle(withVoid, STAKES_DEFAULTS);
    // Tallies and every non-VOID amount are unchanged by the VOID entry.
    expect({ ...b.record, voidCount: 0n, voidStake: 0n }).toEqual(a.record);
    expect(b.record.voidCount).toBe(1n);
    expect(b.record.voidStake).toBe(s);
    expect(b.payouts.filter((p) => p.account !== addr(100))).toEqual(a.payouts);
    expect(b.payouts.find((p) => p.account === addr(100))).toEqual({
      account: addr(100),
      kind: 'void_refund',
      amount: s,
    });
    checkInvariant(b.record, b.payouts);
  });

  it.each(VOID_REASONS)(
    '%s: excluded and refunded in a Free round with uneven stakes',
    (reason) => {
      const entries = [
        valid(1, 0, 70n),
        valid(2, 1, 20n),
        valid(3, 1, 30n),
        voided(4, 12_345n, reason),
      ];
      const { record, payouts } = settle(entries, FREE_DEFAULTS);
      expect(record.n).toEqual([1n, 2n]);
      expect(record.w).toEqual([70n, 50n]);
      expect(record.total).toBe(120n);
      expect(payouts.find((p) => p.account === addr(4))).toEqual({
        account: addr(4),
        kind: 'void_refund',
        amount: 12_345n,
      });
      checkInvariant(record, payouts);
    },
  );

  it('all seven reasons in one round', () => {
    const entries = [
      ...fixedRound(USDC, 3, 30),
      ...VOID_REASONS.map((r, i) => voided(1000 + i, USDC, r)),
    ];
    const { record, payouts } = settle(entries, STAKES_DEFAULTS);
    expect(record.voidCount).toBe(7n);
    expect(payouts.filter((p) => p.kind === 'void_refund')).toHaveLength(7);
    checkInvariant(record, payouts);
  });

  it('rejects malformed entries', () => {
    const bad: EntryInput[][] = [
      [{ account: addr(1), stake: 1n, option: 0, voidReason: 'bad_option' }],
      [{ account: addr(1), stake: 1n, option: null, voidReason: null }],
      [{ account: addr(1), stake: 1n, option: null, voidReason: 'nope' as never }],
      [{ account: addr(1), stake: 0n, option: 0, voidReason: null }],
      [{ account: addr(1), stake: -1n, option: 0, voidReason: null }],
      [valid(1, 0, 1n), valid(1, 1, 1n)],
      [{ account: '0xABC', stake: 1n, option: 0, voidReason: null }],
    ];
    for (const entries of bad) expect(() => settle(entries, FREE_DEFAULTS)).toThrow();
  });
});
