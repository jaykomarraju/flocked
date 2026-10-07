import { comparePayouts } from './settle.js';
import type { Payout, SettlementRecord } from './types.js';

export class InvariantError extends Error {
  override name = 'InvariantError';
}

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new InvariantError(msg);
}

/**
 * Checks the settlement invariant
 *   Σ payout(M) + Σ payout(L) + Σ s(VOID) + F + C + dust = T + V
 * and the structural rules around it. Throws `InvariantError` on any violation.
 */
export function checkInvariant(record: SettlementRecord, payouts: readonly Payout[]): void {
  let sum = 0n;
  let voidRefunds = 0n;
  for (const [idx, p] of payouts.entries()) {
    check(typeof p.amount === 'bigint', `payout ${idx} amount is not bigint`);
    check(p.amount >= 0n, `payout ${idx} (${p.account}) is negative`);
    const prev = payouts[idx - 1];
    if (prev !== undefined)
      check(comparePayouts(prev, p) < 0, `payouts not sorted/unique at ${idx}`);
    sum += p.amount;
    if (p.kind === 'void_refund') voidRefunds += p.amount;
  }
  const [n0, n1] = record.n;
  const [w0, w1] = record.w;
  check(record.total === w0 + w1, 'total != W(0) + W(1)');
  check(record.voidStake >= 0n && record.voidCount >= 0n, 'negative VOID tallies');
  check(record.creatorAward >= 0n, 'negative creator award');
  const tv = record.total + record.voidStake;

  if (record.outcome === 'refunded') {
    check(
      record.refundReason !== null && record.winner === null,
      'refund needs a reason and no winner',
    );
    for (const k of [
      'lossPool',
      'fee',
      'creatorFee',
      'distributable',
      'rebatePool',
      'dust',
      'creatorAward',
    ] as const) {
      check(record[k] === 0n, `refunded record has non-zero ${k}`);
    }
    check(
      payouts.every((p) => p.kind === 'refund'),
      'refunded round may only pay refunds',
    );
    check(sum === tv, `refund sum ${sum} != T + V ${tv}`);
    return;
  }

  check(
    record.refundReason === null && record.winner !== null,
    'settlement needs a winner and no refund reason',
  );
  const winner = record.winner;
  const nM = winner === 0 ? n0 : n1;
  const nL = winner === 0 ? n1 : n0;
  check(nM > 0n && nL > nM, 'winner must be the strictly smaller non-empty side');
  check(record.lossPool === (winner === 0 ? w1 : w0), 'lossPool != W(L)');
  for (const k of ['fee', 'creatorFee', 'distributable', 'rebatePool', 'dust'] as const) {
    check(record[k] >= 0n, `negative ${k}`);
  }
  check(
    record.distributable === record.lossPool - record.fee - record.creatorFee,
    'D != Lp - F - C',
  );
  check(record.rebatePool <= record.distributable, 'R > D');
  check(record.dust < nL, 'dust must be below the losing headcount');
  check(
    payouts.every((p) => p.kind !== 'refund'),
    'settled round may not pay refunds',
  );
  check(voidRefunds === record.voidStake, 'VOID refunds != V');
  check(
    sum + record.fee + record.creatorFee + record.dust === tv,
    `invariant: ${sum} + F + C + dust != T + V ${tv}`,
  );
}
