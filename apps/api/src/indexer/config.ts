// Which contracts the indexer follows on this deployment's chain: FlockedEscrow and FlockedAnchor from
// @flocked/abi (`addressesFor`; on anvil the stack's LOCAL_DEPLOYMENT).
import { addressesFor, flockedAnchorAbi, flockedEscrowAbi, LOCAL_CHAIN_ID } from '@flocked/abi';
import type { Hex } from 'viem';
import type { IndexerEnv, IndexerTarget } from './types.js';

export interface IndexerConfig {
  chainId: number;
  targets: IndexerTarget[];
}

/**
 * The chain and contracts to index, or a reason they can't be resolved (no deployment on the chain
 * yet, or a malformed LOCAL_DEPLOYMENT). Never throws.
 */
export function indexerConfig(
  env: Pick<IndexerEnv, 'CHAIN_ID' | 'LOCAL_DEPLOYMENT'>,
): { ok: true; config: IndexerConfig } | { ok: false; reason: string } {
  const chainId = Number(env.CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, reason: 'bad CHAIN_ID' };
  try {
    const local =
      chainId === LOCAL_CHAIN_ID && env.LOCAL_DEPLOYMENT !== undefined
        ? (JSON.parse(env.LOCAL_DEPLOYMENT) as unknown)
        : undefined;
    const d = addressesFor(chainId, local);
    const startBlock = Number(d.deployBlock);
    return {
      ok: true,
      config: {
        chainId,
        targets: [
          {
            kind: 'escrow',
            address: d.escrow.toLowerCase() as Hex,
            abi: flockedEscrowAbi,
            startBlock,
          },
          {
            kind: 'anchor',
            address: d.anchor.toLowerCase() as Hex,
            abi: flockedAnchorAbi,
            startBlock,
          },
        ],
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
