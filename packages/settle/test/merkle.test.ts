import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { bytesToHex, concat, keccak256, pad } from 'viem';
import { describe, expect, it } from 'vitest';
import type { FreeCommitmentLeaf } from '../src/index.js';
import {
  FREE_COMMITMENT_LEAF,
  FREE_PAYOUT_LEAF,
  STAKES_PAYOUT_LEAF,
  freeCommitmentTree,
  freePayoutTree,
  stakesPayoutTree,
  userIdHash,
} from '../src/index.js';

const hex32 = (i: number) => keccak256(pad(`0x${i.toString(16)}`, { size: 32 }));
const address = (i: number): `0x${string}` => `0x${hex32(i).slice(26)}`;
const roundId = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

describe('Merkle trees match OpenZeppelin StandardMerkleTree', () => {
  it.each([1, 2, 3, 7, 1000])('stakesPayoutTree with %i leaves', (count) => {
    const leaves = Array.from({ length: count }, (_, i) => ({
      account: address(i),
      kind: (i % 3) as 0 | 1 | 2,
    }));
    const t = stakesPayoutTree(42n, leaves);
    const oz = StandardMerkleTree.of(
      leaves.map((l) => [42n, l.account, l.kind]),
      [...STAKES_PAYOUT_LEAF],
    );
    expect(t.root).toBe(oz.root);
    for (const l of leaves.slice(0, 50)) {
      const proof = t.proof(l.account, l.kind);
      expect(
        StandardMerkleTree.verify(t.root, [...STAKES_PAYOUT_LEAF], [42n, l.account, l.kind], proof),
      ).toBe(true);
    }
    const [first] = leaves;
    if (count === 1 && first) expect(t.proof(first.account, first.kind)).toEqual([]);
  });

  it('freePayoutTree', () => {
    const leaves = Array.from({ length: 9 }, (_, i) => ({
      userIdHash: hex32(i),
      amount: BigInt(i) * 10n ** 18n,
    }));
    const t = freePayoutTree(roundId, leaves);
    const rid = bytesToHex(roundId);
    const oz = StandardMerkleTree.of(
      leaves.map((l) => [rid, l.userIdHash, l.amount]),
      [...FREE_PAYOUT_LEAF],
    );
    expect(t.root).toBe(oz.root);
    for (const l of leaves) {
      expect(
        StandardMerkleTree.verify(
          t.root,
          [...FREE_PAYOUT_LEAF],
          [rid, l.userIdHash, l.amount],
          t.proof(l.userIdHash),
        ),
      ).toBe(true);
    }
  });

  it('freeCommitmentTree', () => {
    const leaves: FreeCommitmentLeaf[] = Array.from({ length: 5 }, (_, i) => ({
      roundId,
      mode: 0,
      userIdHash: hex32(i),
      stake: BigInt(i + 1) * 100n,
      commitment: hex32(1000 + i),
      seq: i,
    }));
    const t = freeCommitmentTree(leaves);
    const values = leaves.map((l) => [
      bytesToHex(l.roundId),
      l.mode,
      l.userIdHash,
      l.stake,
      l.commitment,
      l.seq,
    ]);
    expect(t.root).toBe(StandardMerkleTree.of(values, [...FREE_COMMITMENT_LEAF]).root);
    values.forEach((v, i) => {
      expect(StandardMerkleTree.verify(t.root, [...FREE_COMMITMENT_LEAF], v, t.proof(i))).toBe(
        true,
      );
    });
  });

  it('rejects duplicates, empty trees and out-of-range values', () => {
    expect(() => stakesPayoutTree(1n, [])).toThrow();
    expect(() =>
      stakesPayoutTree(1n, [
        { account: address(1), kind: 0 },
        { account: address(1), kind: 0 },
      ]),
    ).toThrow();
    expect(() =>
      stakesPayoutTree(1n, [{ account: '0xABCDEF0000000000000000000000000000000000', kind: 0 }]),
    ).toThrow();
    expect(() => stakesPayoutTree(-1n, [{ account: address(1), kind: 0 }])).toThrow();
    expect(() =>
      freePayoutTree(new Uint8Array(15), [{ userIdHash: hex32(1), amount: 1n }]),
    ).toThrow();
    expect(() =>
      freeCommitmentTree([
        { roundId, mode: 0, userIdHash: hex32(1), stake: 1n << 64n, commitment: hex32(2), seq: 0 },
      ]),
    ).toThrow();
  });
});

describe('userIdHash', () => {
  it('is keccak256(abi.encode(bytes16 roundId, bytes16 userId))', () => {
    const userId = Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i);
    const manual = keccak256(
      concat([
        pad(bytesToHex(roundId), { dir: 'right', size: 32 }),
        pad(bytesToHex(userId), { dir: 'right', size: 32 }),
      ]),
    );
    expect(userIdHash(roundId, userId)).toBe(manual);
    expect(() => userIdHash(roundId, new Uint8Array(32))).toThrow();
  });
});
