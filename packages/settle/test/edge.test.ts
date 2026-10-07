import { describe, expect, it } from 'vitest';
import { checkInvariant, settle, settleStakesClosedForm } from '../src/index.js';
import { FREE_DEFAULTS, STAKES_DEFAULTS, USDC, addr, amountOf, fixedRound, valid } from './helpers.js';

describe('SET-5 single-base-unit stakes', () => {
  it('Stakes, stake 1, 21 vs 30: fee floors to 1, creator fee to 0, the rest is dust', () => {
    const { record, payouts } = settle(fixedRound(1n, 21, 30), STAKES_DEFAULTS);
    expect(record).toMatchObject({ lossPool: 30n, fee: 1n, creatorFee: 0n, distributable: 29n, rebatePool: 8n, dust: 8n });
    expect(amountOf(payouts, addr(1))).toBe(2n);
    checkInvariant(record, payouts);
    const cf = settleStakesClosedForm({ stake: 1n, n0: 21n, n1: 30n, nVoid: 0n, ...STAKES_DEFAULTS });
    expect(cf).toMatchObject({ w: 1n, r: 0n, dust: 8n, winPayout: 2n, rebatePayout: 0n });
  });

  it('Stakes, stake 1, cap binding at 1 vs 20', () => {
    const cf = settleStakesClosedForm({ stake: 1n, n0: 1n, n1: 20n, nVoid: 2n, ...STAKES_DEFAULTS });
    expect(cf).toMatchObject({ lossPool: 20n, fee: 1n, creatorFee: 0n, distributable: 19n, w: 10n, rebatePool: 9n, r: 0n, dust: 9n });
    expect(cf.roundBalance).toBe(23n);
  });

  it('Free, every stake 1 point', () => {
    const entries = [valid(1, 0, 1n), valid(2, 1, 1n), valid(3, 1, 1n)];
    const { record, payouts } = settle(entries, FREE_DEFAULTS);
    expect(amountOf(payouts, addr(1))).toBe(3n);
    expect(record.dust).toBe(0n);
    expect(record.creatorAward).toBe(0n);
    checkInvariant(record, payouts);
  });
});

describe('SET-6 largest Stakes values in bigint', () => {
  const s = 100n * USDC;

  it('100 USDC × 100,000 vs 150,000 entries through the general formula equals the closed form', () => {
    const entries = fixedRound(s, 100_000, 150_000, 1_000);
    const { record, payouts } = settle(entries, STAKES_DEFAULTS);
    checkInvariant(record, payouts);
    const cf = settleStakesClosedForm({ stake: s, n0: 100_000n, n1: 150_000n, nVoid: 1_000n, ...STAKES_DEFAULTS });
    expect(record.lossPool).toBe(15_000_000_000_000n);
    expect(cf.roundBalance).toBe(25_100_000_000_000n);
    expect(amountOf(payouts, addr(1))).toBe(cf.winPayout);
    expect(record.dust).toBe(cf.dust);
    expect(record.total + record.voidStake).toBe(cf.roundBalance);
  });

  it('headcounts in the billions stay exact beyond 2^53', () => {
    const cf = settleStakesClosedForm({ stake: s, n0: 1_000_000_000n, n1: 3_000_000_007n, nVoid: 12_345n, ...STAKES_DEFAULTS });
    expect(cf.lossPool).toBe(300_000_000_700_000_000n);
    expect(cf.lossPool > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(cf.fee).toBe(15_000_000_035_000_000n);
    expect(cf.creatorFee).toBe(3_000_000_007_000_000n);
    expect(cf.distributable).toBe(282_000_000_658_000_000n);
    expect(cf.w).toBe(282_000_000n);
    expect(cf.rebatePool).toBe(658_000_000n);
    expect(cf.r).toBe(0n);
    expect(cf.dust).toBe(658_000_000n);
    const lhs = 1_000_000_000n * cf.winPayout + 3_000_000_007n * cf.rebatePayout + 12_345n * cf.voidRefund + cf.fee + cf.creatorFee + cf.dust;
    expect(lhs).toBe(cf.roundBalance);
  });
});
