import { describe, expect, it } from 'vitest';
import { checkInvariant, settle } from '../src/index.js';
import { FREE_DEFAULTS, addr, amountOf, valid } from './helpers.js';

describe('SET-3 Free: headcount minority holding more stake', () => {
  // Option 0 has fewer entrants (2) but far more stake (1500) than option 1 (5 × 1000 = 5000 is the loss pool).
  const entries = [
    valid(1, 0, 1000n),
    valid(2, 0, 500n),
    valid(3, 1, 1000n),
    valid(4, 1, 1000n),
    valid(5, 1, 1000n),
    valid(6, 1, 1000n),
    valid(7, 1, 1000n),
  ];

  it('the smaller headcount wins regardless of stake, payouts proportional to stake', () => {
    const { record, payouts } = settle(entries, FREE_DEFAULTS);
    expect(record.winner).toBe(0);
    expect(record.n).toEqual([2n, 5n]);
    expect(record.w).toEqual([1500n, 5000n]);
    expect(record.lossPool).toBe(5000n);
    expect(record.fee).toBe(0n);
    expect(record.creatorFee).toBe(0n);
    expect(amountOf(payouts, addr(1))).toBe(1000n + 3333n);
    expect(amountOf(payouts, addr(2))).toBe(500n + 1666n);
    expect(record.rebatePool).toBe(1n);
    expect(record.dust).toBe(1n); // floor(1·1000/5000) = 0 per loser; the 1 point is burned
    for (let i = 3; i <= 7; i++) expect(amountOf(payouts, addr(i))).toBe(0n);
    checkInvariant(record, payouts);
  });

  it('the creator award is floor(Lp · creatorAwardBps / 10000) and sits outside the invariant', () => {
    const { record, payouts } = settle(entries, FREE_DEFAULTS);
    expect(record.creatorAward).toBe(50n);
    const paid = payouts.reduce((a, p) => a + p.amount, 0n);
    expect(paid + record.dust).toBe(record.total + record.voidStake);
  });

  it('a minority winner whose stake dwarfs the pool is not capped and gets less than its stake in winnings', () => {
    const e = [valid(1, 0, 1_000_000n), valid(2, 1, 3n), valid(3, 1, 4n)];
    const { record, payouts } = settle(e, FREE_DEFAULTS);
    expect(amountOf(payouts, addr(1))).toBe(1_000_007n);
    expect(record.rebatePool).toBe(0n);
    checkInvariant(record, payouts);
  });
});
