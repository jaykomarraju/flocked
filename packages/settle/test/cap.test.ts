import { describe, expect, it } from 'vitest';
import { checkInvariant, settle, settleStakesClosedForm } from '../src/index.js';
import {
  FREE_DEFAULTS,
  STAKES_DEFAULTS,
  USDC,
  addr,
  amountOf,
  fixedRound,
  valid,
} from './helpers.js';

describe('SET-2 cap and rebates', () => {
  it('cap not binding (30 vs 12 at 5 USDC): winners split D, rebates are zero', () => {
    const s = 5n * USDC;
    const { record, payouts } = settle(fixedRound(s, 30, 12, 1), STAKES_DEFAULTS);
    expect(record).toMatchObject({
      outcome: 'settled',
      winner: 1,
      lossPool: 150_000_000n,
      fee: 7_500_000n,
      creatorFee: 1_500_000n,
      distributable: 141_000_000n,
      rebatePool: 0n,
      dust: 0n,
      voidCount: 1n,
      voidStake: s,
    });
    expect(payouts.filter((p) => p.kind === 'win').every((p) => p.amount === 16_750_000n)).toBe(
      true,
    );
    expect(payouts.some((p) => p.kind === 'rebate')).toBe(false);
    checkInvariant(record, payouts);
  });

  it('cap binding (1 vs 20 at 1 USDC): winner gets 11x, losers share the rebate pool', () => {
    const { record, payouts } = settle(fixedRound(USDC, 1, 20), STAKES_DEFAULTS);
    expect(record).toMatchObject({
      lossPool: 20n * USDC,
      fee: USDC,
      creatorFee: 200_000n,
      distributable: 18_800_000n,
    });
    expect(record.rebatePool).toBe(8_800_000n);
    expect(amountOf(payouts, addr(1))).toBe(11n * USDC);
    for (let i = 2; i <= 21; i++) expect(amountOf(payouts, addr(i))).toBe(440_000n);
    expect(record.dust).toBe(0n);
    checkInvariant(record, payouts);
  });

  it('Stakes cap boundary: N_L/N_M = 10 does not bind, 11 does (6% fees)', () => {
    const p = { ...STAKES_DEFAULTS, minEntrants: 1 };
    const notBinding = settleStakesClosedForm({ stake: USDC, n0: 1n, n1: 10n, nVoid: 0n, ...p });
    expect(notBinding.w).toBe(9_400_000n);
    expect(notBinding.rebatePool).toBe(0n);
    const binding = settleStakesClosedForm({ stake: USDC, n0: 1n, n1: 11n, nVoid: 0n, ...p });
    expect(binding.w).toBe(10n * USDC);
    expect(binding.rebatePool).toBe(340_000n);
    expect(binding.r).toBe(30_909n);
    expect(binding.dust).toBe(340_000n - 11n * 30_909n);
  });

  it('capMultiple 1 binds early and returns most of the pool to losers', () => {
    const cf = settleStakesClosedForm({
      stake: 2n * USDC,
      n0: 5n,
      n1: 15n,
      nVoid: 0n,
      ...STAKES_DEFAULTS,
      capMultiple: 1,
    });
    expect(cf.w).toBe(2n * USDC);
    expect(cf.winPayout).toBe(4n * USDC);
    expect(cf.rebatePool).toBe(cf.distributable - 5n * 2n * USDC);
    expect(cf.r).toBeGreaterThan(0n);
  });

  it('fees are charged on the whole loss pool even when the cap returns most of it', () => {
    const cf = settleStakesClosedForm({
      stake: USDC,
      n0: 1n,
      n1: 100n,
      nVoid: 0n,
      ...STAKES_DEFAULTS,
    });
    expect(cf.fee).toBe(5n * USDC);
    expect(cf.creatorFee).toBe(USDC);
    expect(cf.w).toBe(10n * USDC);
  });

  it('Free: the cap binds with uneven stakes, rebates are proportional to stake, dust burned', () => {
    const entries = [
      valid(1, 0, 1n),
      valid(2, 0, 1n),
      valid(3, 1, 100n),
      valid(4, 1, 50n),
      valid(5, 1, 30n),
    ];
    const { record, payouts } = settle(entries, FREE_DEFAULTS);
    expect(record).toMatchObject({
      winner: 0,
      lossPool: 180n,
      fee: 0n,
      creatorFee: 0n,
      distributable: 180n,
      rebatePool: 160n,
    });
    expect(amountOf(payouts, addr(1))).toBe(11n);
    expect(amountOf(payouts, addr(2))).toBe(11n);
    expect(amountOf(payouts, addr(3))).toBe(88n);
    expect(amountOf(payouts, addr(4))).toBe(44n);
    expect(amountOf(payouts, addr(5))).toBe(26n);
    expect(record.dust).toBe(2n);
    expect(record.creatorAward).toBe(1n);
    checkInvariant(record, payouts);
  });

  it('zero rebates are omitted from the payout list', () => {
    const { payouts } = settle(fixedRound(USDC, 9, 12), STAKES_DEFAULTS);
    expect(payouts.filter((p) => p.kind === 'rebate')).toHaveLength(0);
    expect(payouts).toHaveLength(9);
  });
});
