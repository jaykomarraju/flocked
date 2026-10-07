import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EntryInput, SettleParams } from '../src/index.js';
import { checkInvariant, settle, settleStakesClosedForm } from '../src/index.js';
import { NUM_RUNS, entriesArb, fixedRound, paramsArb, realisticParamsArb } from './helpers.js';

const runs = { numRuns: NUM_RUNS };
const roundArb = fc.tuple(entriesArb, fc.oneof(paramsArb, realisticParamsArb));

function payoutByAccount(payouts: { account: string; amount: bigint }[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const p of payouts) m.set(p.account, (m.get(p.account) ?? 0n) + p.amount);
  return m;
}

describe('property', () => {
  it('PROP-1: the invariant always holds and no payout is negative', () => {
    fc.assert(
      fc.property(roundArb, ([entries, params]) => {
        const { record, payouts } = settle(entries, params);
        checkInvariant(record, payouts);
        expect(payouts.every((p) => p.amount >= 0n)).toBe(true);
      }),
      runs,
    );
  });

  it('PROP-2: winner payout in [s, (1+cap)·s]; loser payout in [0, s]', () => {
    fc.assert(
      fc.property(roundArb, ([entries, params]) => {
        const { record, payouts } = settle(entries, params);
        const paid = payoutByAccount(payouts);
        const cap = BigInt(params.capMultiple);
        for (const e of entries) {
          const amount = paid.get(e.account) ?? 0n;
          if (record.outcome === 'refunded' || e.option === null) {
            expect(amount).toBe(e.stake);
          } else if (e.option === record.winner) {
            expect(amount >= e.stake && amount <= (1n + cap) * e.stake).toBe(true);
          } else {
            expect(amount >= 0n && amount <= e.stake).toBe(true);
          }
        }
      }),
      runs,
    );
  });

  it('PROP-3: dust is below the losing headcount', () => {
    fc.assert(
      fc.property(roundArb, ([entries, params]) => {
        const { record } = settle(entries, params);
        if (record.winner === null) {
          expect(record.dust).toBe(0n);
        } else {
          expect(record.dust < record.n[record.winner === 0 ? 1 : 0]).toBe(true);
        }
      }),
      runs,
    );
  });

  it('PROP-4: results are independent of entry order', () => {
    const arb = roundArb.chain(([entries, params]) =>
      fc.tuple(
        fc.constant(entries),
        fc.shuffledSubarray(entries, { minLength: entries.length }),
        fc.constant(params),
      ),
    );
    fc.assert(
      fc.property(arb, ([entries, shuffled, params]) => {
        expect(settle(shuffled, params)).toEqual(settle(entries, params));
      }),
      runs,
    );
  });

  it('PROP-5: the Stakes closed form equals the general formula per entry', () => {
    const arb = fc.record({
      stake: fc.oneof(
        fc.bigInt({ min: 1n, max: 100_000_000n }),
        fc.constantFrom(1n, 100_000_000n),
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
      ),
      n0: fc.integer({ min: 0, max: 120 }),
      n1: fc.integer({ min: 0, max: 120 }),
      nVoid: fc.integer({ min: 0, max: 8 }),
      params: fc.oneof(paramsArb, realisticParamsArb),
    });
    fc.assert(
      fc.property(arb, ({ stake, n0, n1, nVoid, params }) => {
        const p: SettleParams = { ...params, creatorAwardBps: 0 };
        const entries: EntryInput[] = fixedRound(stake, n0, n1, nVoid);
        const { record, payouts } = settle(entries, p);
        const cf = settleStakesClosedForm({
          stake,
          n0: BigInt(n0),
          n1: BigInt(n1),
          nVoid: BigInt(nVoid),
          ...p,
        });

        expect(cf.outcome).toBe(record.outcome);
        expect(cf.refundReason).toBe(record.refundReason);
        expect(cf.winner).toBe(record.winner);
        expect(cf.lossPool).toBe(record.lossPool);
        expect(cf.fee).toBe(record.fee);
        expect(cf.creatorFee).toBe(record.creatorFee);
        expect(cf.distributable).toBe(record.distributable);
        expect(cf.rebatePool).toBe(record.rebatePool);
        expect(cf.dust).toBe(record.dust);
        expect(cf.roundBalance).toBe(record.total + record.voidStake);

        const paid = payoutByAccount(payouts);
        for (const e of entries) {
          const amount = paid.get(e.account) ?? 0n;
          if (record.outcome === 'refunded' || e.option === null)
            expect(amount).toBe(cf.voidRefund);
          else if (e.option === record.winner) expect(amount).toBe(cf.winPayout);
          else expect(amount).toBe(cf.rebatePayout);
        }
      }),
      runs,
    );
  });
});
