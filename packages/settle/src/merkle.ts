import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { bytesToHex, encodeAbiParameters, isHex, keccak256 } from 'viem';

type Hex = `0x${string}`;

export const STAKES_PAYOUT_LEAF = ['uint256', 'address', 'uint8'] as const;
export const FREE_PAYOUT_LEAF = ['bytes16', 'bytes32', 'uint256'] as const;
export const FREE_COMMITMENT_LEAF = ['bytes16', 'uint8', 'bytes32', 'uint64', 'bytes32', 'uint32'] as const;

/** Stakes payout leaf kind: 0 = Win, 1 = Rebate, 2 = VoidRefund. */
export type StakesLeafKind = 0 | 1 | 2;

export interface FreeCommitmentLeaf {
  roundId: Uint8Array;
  /** 0 = free, 1 = stakes. */
  mode: 0 | 1;
  userIdHash: Hex;
  stake: bigint;
  commitment: Hex;
  seq: number;
}

export interface PayoutTree<K extends unknown[]> {
  root: Hex;
  proof(...key: K): Hex[];
}

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function bytes16(b: Uint8Array, name: string): Hex {
  if (b.length !== 16) throw new TypeError(`${name} must be 16 bytes, got ${b.length}`);
  return bytesToHex(b);
}

function bytes32(h: Hex, name: string): Hex {
  if (!isHex(h, { strict: true }) || h.length !== 66 || h !== h.toLowerCase()) {
    throw new TypeError(`${name} must be lowercase 0x bytes32 hex: ${h}`);
  }
  return h;
}

function uint(v: bigint, max: bigint, name: string): bigint {
  if (typeof v !== 'bigint' || v < 0n || v > max) throw new RangeError(`${name} out of range: ${String(v)}`);
  return v;
}

function build<T extends unknown[]>(values: T[], encoding: readonly string[], keyOf: (v: T) => string) {
  if (values.length === 0) throw new RangeError('a Merkle tree needs at least one leaf');
  const index = new Map<string, number>();
  values.forEach((v, i) => {
    const k = keyOf(v);
    if (index.has(k)) throw new TypeError(`duplicate leaf: ${k}`);
    index.set(k, i);
  });
  const tree = StandardMerkleTree.of(values, [...encoding]);
  return {
    root: tree.root as Hex,
    proofOf(key: string): Hex[] {
      const i = index.get(key);
      if (i === undefined) throw new RangeError(`no leaf for ${key}`);
      return tree.getProof(i) as Hex[];
    },
  };
}

/** Stakes payout tree: leaves (uint256 chainRoundId, address account, uint8 kind). */
export function stakesPayoutTree(
  chainRoundId: bigint,
  leaves: { account: Hex; kind: StakesLeafKind }[],
): PayoutTree<[account: Hex, kind: StakesLeafKind]> {
  uint(chainRoundId, UINT256_MAX, 'chainRoundId');
  const values = leaves.map(({ account, kind }): [bigint, Hex, number] => {
    if (!/^0x[0-9a-f]{40}$/.test(account)) throw new TypeError(`account must be a lowercase address: ${account}`);
    const k: number = kind; // runtime check for untyped callers
    if (k !== 0 && k !== 1 && k !== 2) throw new RangeError(`bad kind ${k}`);
    return [chainRoundId, account, kind];
  });
  const t = build(values, STAKES_PAYOUT_LEAF, (v) => `${v[1]}:${v[2]}`);
  return { root: t.root, proof: (account, kind) => t.proofOf(`${account.toLowerCase()}:${kind}`) };
}

/** Free payout tree: leaves (bytes16 roundId, bytes32 userIdHash, uint256 amount). */
export function freePayoutTree(
  roundId: Uint8Array,
  leaves: { userIdHash: Hex; amount: bigint }[],
): PayoutTree<[userIdHash: Hex]> {
  const rid = bytes16(roundId, 'roundId');
  const values = leaves.map(({ userIdHash: u, amount }): [Hex, Hex, bigint] => [
    rid,
    bytes32(u, 'userIdHash'),
    uint(amount, UINT256_MAX, 'amount'),
  ]);
  const t = build(values, FREE_PAYOUT_LEAF, (v) => v[1]);
  return { root: t.root, proof: (u) => t.proofOf(u.toLowerCase()) };
}

/**
 * Free commitment tree (the receipts): leaves
 * (bytes16 roundId, uint8 mode, bytes32 userIdHash, uint64 stake, bytes32 commitment, uint32 seq).
 * Proofs are looked up by `seq`, which is unique per round.
 */
export function freeCommitmentTree(leaves: FreeCommitmentLeaf[]): PayoutTree<[seq: number]> {
  const values = leaves.map((l): [Hex, number, Hex, bigint, Hex, number] => {
    const mode: number = l.mode; // runtime check for untyped callers
    if (mode !== 0 && mode !== 1) throw new RangeError(`bad mode ${mode}`);
    if (!Number.isInteger(l.seq) || l.seq < 0 || l.seq > 0xffffffff) throw new RangeError(`bad seq ${l.seq}`);
    return [
      bytes16(l.roundId, 'roundId'),
      l.mode,
      bytes32(l.userIdHash, 'userIdHash'),
      uint(l.stake, UINT64_MAX, 'stake'),
      bytes32(l.commitment, 'commitment'),
      l.seq,
    ];
  });
  const t = build(values, FREE_COMMITMENT_LEAF, (v) => String(v[5]));
  return { root: t.root, proof: (seq) => t.proofOf(String(seq)) };
}

/** userIdHash = keccak256(abi.encode(bytes16 roundId, bytes16 userId)). */
export function userIdHash(roundId: Uint8Array, userId: Uint8Array): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'bytes16' }, { type: 'bytes16' }], [bytes16(roundId, 'roundId'), bytes16(userId, 'userId')]),
  );
}
