import fc from 'fast-check';
import type { EntryInput, OptionIndex, SettleParams, VoidReason } from '../src/index.js';
import { VOID_REASONS } from '../src/index.js';

export const STAKES_DEFAULTS: SettleParams = { feeBps: 500, creatorBps: 100, capMultiple: 10, minEntrants: 20 };
export const FREE_DEFAULTS: SettleParams = { feeBps: 0, creatorBps: 0, capMultiple: 10, minEntrants: 1, creatorAwardBps: 100 };
export const USDC = 1_000_000n;

export const NUM_RUNS = Number(process.env.FAST_CHECK_RUNS ?? 1000);

/** Deterministic lowercase 20-byte address for index i. */
export function addr(i: number): string {
  return `0x${i.toString(16).padStart(40, '0')}`;
}

export function valid(i: number, option: OptionIndex, stake: bigint, qualifies?: boolean): EntryInput {
  return { account: addr(i), stake, option, voidReason: null, ...(qualifies === undefined ? {} : { qualifies }) };
}

export function voided(i: number, stake: bigint, voidReason: VoidReason = 'decrypt_failed'): EntryInput {
  return { account: addr(i), stake, option: null, voidReason };
}

/** A fixed-stake (Stakes-style) round: n0 on option 0, n1 on option 1, nVoid VOID entries. */
export function fixedRound(stake: bigint, n0: number, n1: number, nVoid = 0): EntryInput[] {
  const out: EntryInput[] = [];
  let i = 1;
  for (let k = 0; k < n0; k++) out.push(valid(i++, 0, stake));
  for (let k = 0; k < n1; k++) out.push(valid(i++, 1, stake));
  for (let k = 0; k < nVoid; k++) out.push(voided(i++, stake, VOID_REASONS[k % VOID_REASONS.length]));
  return out;
}

export function amountOf(payouts: { account: string; amount: bigint }[], account: string): bigint {
  return payouts.filter((p) => p.account === account).reduce((a, p) => a + p.amount, 0n);
}

export const paramsArb: fc.Arbitrary<SettleParams> = fc
  .record({
    feeBps: fc.integer({ min: 0, max: 10_000 }),
    creatorFrac: fc.integer({ min: 0, max: 10_000 }),
    capMultiple: fc.integer({ min: 1, max: 20 }),
    minEntrants: fc.integer({ min: 0, max: 30 }),
    creatorAwardBps: fc.integer({ min: 0, max: 1_000 }),
  })
  .map(({ feeBps, creatorFrac, ...rest }) => ({
    ...rest,
    feeBps,
    creatorBps: Math.floor(((10_000 - feeBps) * creatorFrac) / 10_000),
  }));

/** Realistic params skew: mostly small fees, sometimes extreme. */
export const realisticParamsArb: fc.Arbitrary<SettleParams> = fc.oneof(
  { weight: 3, arbitrary: paramsArb.map((p) => ({ ...p, feeBps: p.feeBps % 1001, creatorBps: p.creatorBps % 501 })) },
  { weight: 1, arbitrary: paramsArb },
);

const entryShapeArb = fc.record({
  stake: fc.oneof(fc.bigInt({ min: 1n, max: 1_000n }), fc.bigInt({ min: 1n, max: 10n ** 30n })),
  kind: fc.oneof(
    { weight: 9, arbitrary: fc.constantFrom<OptionIndex>(0, 1) },
    { weight: 1, arbitrary: fc.constantFrom(...VOID_REASONS) },
  ),
  qualifies: fc.boolean(),
});

/** Arbitrary general (Free-style) rounds with unique accounts and uneven stakes. */
export const entriesArb: fc.Arbitrary<EntryInput[]> = fc
  .array(entryShapeArb, { minLength: 0, maxLength: 60 })
  .map((shapes) =>
    shapes.map((s, i): EntryInput =>
      s.kind === 0 || s.kind === 1
        ? { account: addr(i + 1), stake: s.stake, option: s.kind, voidReason: null, qualifies: s.qualifies }
        : { account: addr(i + 1), stake: s.stake, option: null, voidReason: s.kind },
    ),
  );
