// Close-time work for a Free mode (spec "Sealed picks" › Free mode specifics: the commitment root;
// "Real-time and the reveal": reconcile leaves against D1 and build the root from committed leaves
// only). Pure functions; the RoundDO does the I/O.
import { freeCommitmentTree, type PayoutTree } from '@flocked/settle';
import { MODE_CODES, ulidToBytes } from '@flocked/shared';
import type { Hex } from 'viem';
import type { CommittedEntry } from './entry.js';

/** A leaf as the RoundDO records it after a committed entry. */
export interface Leaf extends CommittedEntry {
  userIdHash: Hex;
}

export interface Reconciliation {
  /** The committed set, by seq: exactly D1's Free entries for the round. */
  committed: CommittedEntry[];
  /** In D1 but not recorded as leaves: committed, never acknowledged (the DO lost the reply). */
  recovered: CommittedEntry[];
  /** Recorded as leaves but absent from D1, or differing from D1. Never expected; alert. */
  inconsistent: number[];
  /** True when the committed seqs are exactly 0 … n − 1. */
  contiguous: boolean;
}

/** Compares the DO's leaves with D1's committed entries. D1 is the system of record. */
export function reconcile(leaves: readonly Leaf[], d1: readonly CommittedEntry[]): Reconciliation {
  const bySeq = new Map(leaves.map((l) => [l.seq, l]));
  const inD1 = new Set<number>();
  const recovered: CommittedEntry[] = [];
  const inconsistent: number[] = [];
  for (const e of d1) {
    inD1.add(e.seq);
    const l = bySeq.get(e.seq);
    if (!l) recovered.push(e);
    else if (
      l.id !== e.id ||
      l.userId !== e.userId ||
      l.stake !== e.stake ||
      l.commitment !== e.commitment
    ) {
      inconsistent.push(e.seq);
    }
  }
  for (const l of leaves) if (!inD1.has(l.seq)) inconsistent.push(l.seq);
  const committed = [...d1].sort((a, b) => a.seq - b.seq);
  const contiguous = committed.every((e, i) => e.seq === i);
  return { committed, recovered, inconsistent: inconsistent.sort((a, b) => a - b), contiguous };
}

export interface FreeRoot {
  root: Hex;
  entryCount: number;
  /** Sum of stakes (uint64 on chain). */
  totalStake: bigint;
  tree: PayoutTree<[seq: number]>;
}

/**
 * The commitment tree over the committed entries (`freeCommitmentTree` leaves: roundId, mode 0,
 * userIdHash, stake, commitment, seq), or null when there are none (nothing to anchor).
 */
export function buildFreeRoot(
  roundId: string,
  entries: readonly (CommittedEntry & { userIdHash: Hex })[],
): FreeRoot | null {
  if (entries.length === 0) return null;
  const roundBytes = ulidToBytes(roundId);
  const tree = freeCommitmentTree(
    entries.map((e) => ({
      roundId: roundBytes,
      mode: MODE_CODES.free,
      userIdHash: e.userIdHash,
      stake: BigInt(e.stake),
      commitment: e.commitment,
      seq: e.seq,
    })),
  );
  const totalStake = entries.reduce((s, e) => s + BigInt(e.stake), 0n);
  return { root: tree.root, entryCount: entries.length, totalStake, tree };
}
