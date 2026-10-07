import { describe, expect, it } from 'vitest';
import { checkInvariant, settle, settleStakesClosedForm } from '../src/index.js';
import { FREE_DEFAULTS, STAKES_DEFAULTS, USDC, addr, fixedRound, valid, voided } from './helpers.js';

const s = 5n * USDC;

function expectRefund(result: ReturnType<typeof settle>, reason: 1 | 2 | 3, entries: { account: string; stake: bigint }[]) {
  const { record, payouts } = result;
  expect(record.outcome).toBe('refunded');
  expect(record.refundReason).toBe(reason);
  expect(record.winner).toBeNull();
  for (const k of ['lossPool', 'fee', 'creatorFee', 'distributable', 'rebatePool', 'dust', 'creatorAward'] as const) {
    expect(record[k]).toBe(0n);
  }
  // Every stake, valid and VOID, comes back as a refund, sorted by account.
  expect(payouts).toEqual(
    [...entries].sort((a, b) => (a.account < b.account ? -1 : 1)).map((e) => ({ account: e.account, kind: 'refund', amount: e.stake })),
  );
  checkInvariant(record, payouts);
}

describe('SET-1 refund rules 1–3', () => {
  it('rule 1: fewer than minEntrants valid entries refunds (minEntrants − 1)', () => {
    const entries = fixedRound(s, 7, 12);
    expectRefund(settle(entries, STAKES_DEFAULTS), 1, entries);
    expect(settleStakesClosedForm({ stake: s, n0: 7n, n1: 12n, nVoid: 0n, ...STAKES_DEFAULTS }).refundReason).toBe(1);
  });

  it('rule 1 boundary: exactly minEntrants valid entries settles', () => {
    const { record } = settle(fixedRound(s, 8, 12), STAKES_DEFAULTS);
    expect(record.outcome).toBe('settled');
    expect(record.winner).toBe(0);
  });

  it('rule 1: VOID entries do not count toward minEntrants', () => {
    const entries = fixedRound(s, 7, 12, 5);
    expectRefund(settle(entries, STAKES_DEFAULTS), 1, entries);
    expect(settleStakesClosedForm({ stake: s, n0: 7n, n1: 12n, nVoid: 5n, ...STAKES_DEFAULTS }).refundReason).toBe(1);
  });

  it('rule 1 (Free, minEntrants 1): no valid entries, only VOIDs, refunds', () => {
    const entries = [voided(1, 40n, 'bad_option'), voided(2, 7n, 'not_anchored')];
    expectRefund(settle(entries, FREE_DEFAULTS), 1, entries);
    expectRefund(settle([], FREE_DEFAULTS), 1, []);
  });

  it('rule 2: one-sided round refunds', () => {
    const entries = fixedRound(s, 0, 25, 2);
    expectRefund(settle(entries, STAKES_DEFAULTS), 2, entries);
    const free = [valid(1, 1, 10n), valid(2, 1, 99n)];
    expectRefund(settle(free, FREE_DEFAULTS), 2, free);
  });

  it('rule 1 takes precedence over rule 2', () => {
    const entries = fixedRound(s, 10, 0);
    expectRefund(settle(entries, STAKES_DEFAULTS), 1, entries);
  });

  it('rule 3: headcount tie refunds', () => {
    const entries = fixedRound(s, 15, 15, 1);
    expectRefund(settle(entries, STAKES_DEFAULTS), 3, entries);
    expect(settleStakesClosedForm({ stake: s, n0: 15n, n1: 15n, nVoid: 1n, ...STAKES_DEFAULTS }).refundReason).toBe(3);
  });

  it('rule 3: a headcount tie refunds even when stakes differ (Free)', () => {
    const entries = [valid(1, 0, 1000n), valid(2, 0, 1n), valid(3, 1, 5n), valid(4, 1, 5n)];
    expectRefund(settle(entries, FREE_DEFAULTS), 3, entries);
  });

  it('a one-entry difference breaks the tie', () => {
    const { record } = settle(fixedRound(s, 15, 16), STAKES_DEFAULTS);
    expect(record.outcome).toBe('settled');
    expect(record.winner).toBe(0);
  });
});

describe('SET-1 room qualification (countQualifyingOnly)', () => {
  const room = { ...FREE_DEFAULTS, creatorAwardBps: 0, minEntrants: 3, countQualifyingOnly: true };

  it('refunds with fewer than 3 qualifying entrants even when more are valid', () => {
    const entries = [valid(1, 0, 10n, true), valid(2, 1, 10n, true), valid(3, 1, 10n, false), valid(4, 1, 10n)];
    expectRefund(settle(entries, room), 1, entries);
  });

  it('settles at exactly 3 qualifying entrants', () => {
    const entries = [valid(1, 0, 10n, true), valid(2, 1, 10n, true), valid(3, 1, 10n, true)];
    const { record, payouts } = settle(entries, room);
    expect(record.outcome).toBe('settled');
    expect(record.creatorAward).toBe(0n);
    checkInvariant(record, payouts);
  });

  it('VOID entries never qualify', () => {
    const entries = [valid(1, 0, 10n, true), valid(2, 1, 10n, true), { ...voided(3, 10n), qualifies: true }];
    expectRefund(settle(entries, room), 1, entries);
  });

  it('without countQualifyingOnly, qualification is ignored', () => {
    const entries = [valid(1, 0, 10n, false), valid(2, 1, 10n, false), valid(3, 1, 10n, false)];
    expect(settle(entries, { ...room, countQualifyingOnly: false }).record.outcome).toBe('settled');
  });

  it('refund payouts are sorted by account', () => {
    const entries = [valid(9, 0, 1n), valid(3, 1, 2n), voided(5, 3n)];
    const { payouts } = settle(entries, room);
    expect(payouts.map((p) => p.account)).toEqual([addr(3), addr(5), addr(9)]);
  });
});
