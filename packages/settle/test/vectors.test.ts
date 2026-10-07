import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { describe, expect, it } from 'vitest';
import { generateVectors } from '../scripts/vectors.js';
import type { EntryInput, OptionIndex, VoidReason } from '../src/index.js';
import { STAKES_PAYOUT_LEAF, settle, settleStakesClosedForm } from '../src/index.js';

const dir = join(import.meta.dirname, '../vectors');
const read = (name: string): string => readFileSync(join(dir, name), 'utf8');

interface ClosedVector {
  id: string;
  stake: string;
  feeBps: string;
  creatorBps: string;
  capMultiple: string;
  minEntrants: string;
  n0: string;
  n1: string;
  nVoid: string;
  expected: Record<string, string>;
}
interface MerkleVector {
  id: string;
  chainRoundId: string;
  leaves: { account: string; kind: string }[];
  root: string;
  proofs: { account: string; kind: string; proof: string[] }[];
}
interface FreeVector {
  id: string;
  params: Record<string, string | boolean>;
  entries: {
    account: string;
    stake: string;
    option: string | null;
    voidReason: VoidReason | null;
    qualifies?: boolean;
  }[];
  expected: {
    record: Record<string, unknown>;
    payouts: { account: string; kind: string; amount: string }[];
  };
}

const closed = (JSON.parse(read('stakes-closed-form.json')) as { vectors: ClosedVector[] }).vectors;
const merkle = (JSON.parse(read('stakes-payout-merkle.json')) as { vectors: MerkleVector[] })
  .vectors;
const free = (JSON.parse(read('free-general.json')) as { vectors: FreeVector[] }).vectors;

describe('vectors', () => {
  it('generation is deterministic and matches the committed files byte for byte', () => {
    const a = generateVectors();
    const b = generateVectors();
    expect(b).toEqual(a);
    for (const [name, contents] of Object.entries(a)) expect(read(name), name).toBe(contents);
  });

  it('every numeric field is a decimal string', () => {
    const check = (v: unknown, path: string): void => {
      expect(typeof v, path).not.toBe('number');
      if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) check(x, `${path}.${k}`);
    };
    check(closed, 'closed');
    check(merkle, 'merkle');
    check(free, 'free');
  });

  it('stakes-closed-form covers P1.1 and re-derives from the closed form', () => {
    expect(closed.length).toBeGreaterThanOrEqual(40);
    const has = (f: (v: ClosedVector) => boolean) => {
      expect(closed.some(f)).toBe(true);
    };
    const e = (v: ClosedVector, k: string) => BigInt(v.expected[k] ?? 'x');
    for (const reason of ['1', '2', '3']) has((v) => v.expected.refundReason === reason);
    has((v) => v.n0 === v.n1 && v.n0 !== '0');
    has((v) => v.expected.status === '2' && e(v, 'w') === BigInt(v.capMultiple) * BigInt(v.stake));
    has((v) => v.expected.status === '2' && e(v, 'w') < BigInt(v.capMultiple) * BigInt(v.stake));
    has((v) => v.expected.status === '2' && e(v, 'r') === 0n);
    has((v) => v.expected.status === '2' && e(v, 'r') > 0n);
    has((v) => v.nVoid === '0');
    has((v) => v.nVoid !== '0');
    has((v) => v.stake === '1');
    has((v) => v.stake === '100000000');
    has((v) => v.feeBps === '0' && v.creatorBps === '0');
    has((v) => BigInt(v.feeBps) + BigInt(v.creatorBps) === 10_000n);
    has((v) => v.capMultiple === '1');
    has((v) => v.capMultiple === '10');
    has((v) => BigInt(v.n0) + BigInt(v.n1) === BigInt(v.minEntrants) - 1n);
    has((v) => BigInt(v.n0) + BigInt(v.n1) === BigInt(v.minEntrants) && v.expected.status === '2');
    has((v) => BigInt(v.n0) >= 100_000n && BigInt(v.n1) >= 100_000n);

    for (const v of closed) {
      const cf = settleStakesClosedForm({
        stake: BigInt(v.stake),
        n0: BigInt(v.n0),
        n1: BigInt(v.n1),
        nVoid: BigInt(v.nVoid),
        feeBps: Number(v.feeBps),
        creatorBps: Number(v.creatorBps),
        capMultiple: Number(v.capMultiple),
        minEntrants: Number(v.minEntrants),
      });
      expect(e(v, 'lossPool'), v.id).toBe(cf.lossPool);
      expect(e(v, 'winPayout'), v.id).toBe(cf.winPayout);
      expect(e(v, 'dust'), v.id).toBe(cf.dust);
      if (v.expected.status === '2') expect(e(v, 'winPayout')).toBe(BigInt(v.stake) + e(v, 'w'));
      expect(e(v, 'roundBalance')).toBe(
        (BigInt(v.n0) + BigInt(v.n1) + BigInt(v.nVoid)) * BigInt(v.stake),
      );
      // The invariant in closed form.
      const [nM, nL] = v.expected.winner === '0' ? [v.n0, v.n1] : [v.n1, v.n0];
      const lhs =
        v.expected.status === '2'
          ? BigInt(nM) * e(v, 'winPayout') +
            BigInt(nL) * e(v, 'rebatePayout') +
            BigInt(v.nVoid) * e(v, 'voidRefund') +
            e(v, 'fee') +
            e(v, 'creatorFee') +
            e(v, 'dust')
          : (BigInt(v.n0) + BigInt(v.n1) + BigInt(v.nVoid)) * e(v, 'voidRefund');
      expect(lhs, v.id).toBe(e(v, 'roundBalance'));
    }
  });

  it('stakes-payout-merkle has 1-, 2-, odd- and >= 1000-leaf trees whose proofs verify with OpenZeppelin', () => {
    const sizes = merkle.map((v) => v.leaves.length);
    expect(sizes).toContain(1);
    expect(sizes).toContain(2);
    expect(sizes.some((n) => n % 2 === 1 && n > 1)).toBe(true);
    expect(sizes.some((n) => n >= 1000)).toBe(true);
    for (const v of merkle) {
      const values = v.leaves.map((l) => [BigInt(v.chainRoundId), l.account, Number(l.kind)]);
      expect(StandardMerkleTree.of(values, [...STAKES_PAYOUT_LEAF]).root, v.id).toBe(v.root);
      for (const p of v.proofs) {
        const leaf = [BigInt(v.chainRoundId), p.account, Number(p.kind)];
        expect(
          StandardMerkleTree.verify(v.root, [...STAKES_PAYOUT_LEAF], leaf, p.proof),
          v.id,
        ).toBe(true);
      }
    }
  });

  it('free-general re-settles to the recorded record and payouts', () => {
    for (const v of free) {
      const entries: EntryInput[] = v.entries.map((x) => ({
        account: x.account,
        stake: BigInt(x.stake),
        option: x.option === null ? null : (Number(x.option) as OptionIndex),
        voidReason: x.voidReason,
        ...(x.qualifies === undefined ? {} : { qualifies: x.qualifies }),
      }));
      const p = v.params;
      const { record, payouts } = settle(entries, {
        feeBps: Number(p.feeBps),
        creatorBps: Number(p.creatorBps),
        capMultiple: Number(p.capMultiple),
        minEntrants: Number(p.minEntrants),
        creatorAwardBps: Number(p.creatorAwardBps),
        countQualifyingOnly: p.countQualifyingOnly === true,
      });
      expect(
        payouts.map((x) => ({ ...x, amount: x.amount.toString() })),
        v.id,
      ).toEqual(v.expected.payouts);
      expect(record.dust.toString(), v.id).toBe(v.expected.record.dust);
      expect(record.creatorAward.toString(), v.id).toBe(v.expected.record.creatorAward);
      expect(record.outcome, v.id).toBe(v.expected.record.outcome);
    }
  });
});
