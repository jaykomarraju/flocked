// Reads from FlockedAnchor through the client's own public RPC (crypto/chain.ts): a Free round's lock
// leaf and the receipt signer. Spec "Sealed picks": the lock leaf commits closesAt, beaconRound, the
// question hash and the Free config hash; receipts are checked against the signer published onchain.
import { flockedAnchorAbi } from '@flocked/abi';
import { roundKey } from '@flocked/shared';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import type { ClientChain } from './chain';

/** The Free lock leaf of a round, as anchored. `lockedAt` 0 means the round was never locked. */
export interface LockLeaf {
  closesAt: number;
  beaconRound: number;
  lockedAt: number;
  questionHash: Hex;
  configHash: Hex;
}

/** What the entry flow reads onchain; tests pass a fake. */
export interface AnchorReader {
  freeLockLeaf(roundId: string): Promise<LockLeaf>;
  receiptSigner(): Promise<Address>;
}

export function anchorReader(chain: ClientChain): AnchorReader {
  const client = createPublicClient({ transport: http(chain.rpcUrl) });
  return {
    async freeLockLeaf(roundId) {
      const a = await client.readContract({
        address: chain.anchor,
        abi: flockedAnchorAbi,
        functionName: 'getAnchor',
        args: [roundKey(roundId, 'free')],
      });
      return {
        closesAt: Number(a.closesAt),
        beaconRound: Number(a.beaconRound),
        lockedAt: Number(a.lockedAt),
        questionHash: a.questionHash,
        configHash: a.configHash,
      };
    },
    receiptSigner: () =>
      client.readContract({
        address: chain.anchor,
        abi: flockedAnchorAbi,
        functionName: 'receiptSigner',
      }),
  };
}
