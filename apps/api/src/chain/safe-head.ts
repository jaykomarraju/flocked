// The close block and Base's safe head (wave-6 pinned interface; spec "Sealed picks" › Stakes mode
// specifics). The close block is the last block stamped before closesAt: FlockedEscrow refuses
// `enter` from closesAt on, so it holds the round's last entry. Stakes settlement counts the
// `Entered` events up to it, and starts only once the safe head has passed it, when no reorg can
// change it any more.
import type { Hex, PublicClient } from 'viem';

export interface CloseBlock {
  number: number;
  /** Lowercase. */
  hash: Hex;
  /** Unix seconds. */
  timestamp: number;
}

/** The close block is no longer on the canonical chain (a reorg below the safe head's reach). */
export class CloseBlockReorgedError extends Error {
  constructor(readonly block: { number: number; hash: Hex }) {
    super(`close block ${block.number} (${block.hash}) is no longer canonical`);
  }
}

async function blockAt(client: PublicClient, n: number): Promise<CloseBlock> {
  const b = await client.getBlock({ blockNumber: BigInt(n) });
  if (b.hash === null) throw new Error(`block ${n} has no hash`);
  return { number: n, hash: b.hash.toLowerCase() as Hex, timestamp: Number(b.timestamp) };
}

/**
 * The last block stamped before `closesAtSec`, or null while the head is still stamped before it
 * (a later block could still be the last one). Block times rise by at least a second per block, so
 * the close block is at most `head.timestamp − closesAt + 1` blocks below the head; a binary search
 * over that span finds it.
 */
export async function closeBlockFor(
  client: PublicClient,
  closesAtSec: number,
): Promise<CloseBlock | null> {
  const head = await client.getBlock({ blockTag: 'latest' });
  const headTs = Number(head.timestamp);
  if (headTs < closesAtSec) return null;
  let hi = Number(head.number); // stamped at or after closesAt
  let span = headTs - closesAtSec + 1;
  let lo = Math.max(0, hi - span);
  let low = await blockAt(client, lo);
  // Only a chain whose block times don't rise every block gets here; widen the span until it holds.
  while (low.timestamp >= closesAtSec) {
    if (lo === 0) throw new Error('the chain starts after closesAt');
    hi = lo;
    span *= 2;
    lo = Math.max(0, hi - span);
    low = await blockAt(client, lo);
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const b = await blockAt(client, mid);
    if (b.timestamp < closesAtSec) {
      lo = mid;
      low = b;
    } else hi = mid;
  }
  return low;
}

/**
 * True once Base's safe head is past `block` (strictly above it), which makes it final. Throws
 * CloseBlockReorgedError when the canonical block at that height is another one.
 */
export async function safeHeadPast(
  client: PublicClient,
  block: { number: number; hash: Hex },
): Promise<boolean> {
  const safe = await client.getBlock({ blockTag: 'safe' });
  const canonical = await blockAt(client, block.number);
  if (canonical.hash !== block.hash.toLowerCase()) throw new CloseBlockReorgedError(block);
  return Number(safe.number) > block.number;
}
