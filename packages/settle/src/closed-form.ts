import { BPS, toBigParams } from './params.js';
import { refundReasonFor } from './settle.js';
import type { OptionIndex, SettleParams, StakesClosedForm } from './types.js';

/**
 * Stakes closed form: every entry has the same stake s, so amounts depend only on headcounts.
 * The contract computes the same values onchain. `countQualifyingOnly` is ignored: onchain every entry qualifies.
 */
export function settleStakesClosedForm(
  i: { stake: bigint; n0: bigint; n1: bigint; nVoid: bigint } & SettleParams,
): StakesClosedForm {
  const p = toBigParams(i);
  const { stake: s, n0, n1, nVoid } = i;
  if (s <= 0n) throw new RangeError('stake must be positive');
  if (n0 < 0n || n1 < 0n || nVoid < 0n) throw new RangeError('headcounts must be non-negative');

  const roundBalance = (n0 + n1 + nVoid) * s;
  const zero = {
    winner: null,
    lossPool: 0n,
    fee: 0n,
    creatorFee: 0n,
    distributable: 0n,
    w: 0n,
    rebatePool: 0n,
    r: 0n,
    dust: 0n,
    winPayout: 0n,
    rebatePayout: 0n,
    voidRefund: s,
    roundBalance,
  } as const;

  const refundReason = refundReasonFor(n0, n1, n0 + n1, p.minEntrants);
  if (refundReason !== null) return { outcome: 'refunded', refundReason, ...zero };

  const winner: OptionIndex = n0 < n1 ? 0 : 1;
  const nM = winner === 0 ? n0 : n1;
  const nL = winner === 0 ? n1 : n0;
  const lossPool = nL * s;
  const fee = (lossPool * p.feeBps) / BPS;
  const creatorFee = (lossPool * p.creatorBps) / BPS;
  const distributable = lossPool - fee - creatorFee;
  const share = distributable / nM;
  const cap = p.capMultiple * s;
  const w = share < cap ? share : cap;
  const rebatePool = distributable - nM * w;
  const r = rebatePool / nL;
  return {
    ...zero,
    outcome: 'settled',
    refundReason: null,
    winner,
    lossPool,
    fee,
    creatorFee,
    distributable,
    w,
    rebatePool,
    r,
    dust: rebatePool - nL * r,
    winPayout: s + w,
    rebatePayout: r,
  };
}
