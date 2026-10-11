// Chain access for the API Worker and its Durable Objects (spec "Architecture"; plan 4.4): the viem
// public client over the deployment's RPC providers, the contract addresses, and the read-only checks
// other modules need. Signing lives in src/chain/tx.ts; the operator key only in src/chain/operator.ts
// and the anchor key only in AnchorDO (wave-4 pinned interfaces).
import { addressesFor, LOCAL_CHAIN_ID, type Deployment } from '@flocked/abi';
import {
  createPublicClient,
  fallback,
  http,
  type Address,
  type PublicClient,
  type Transport,
} from 'viem';
import type { Env } from '../env.js';

export type ChainEnv = Pick<
  Env,
  'CHAIN_ID' | 'BASE_RPC_URL' | 'BASE_RPC_URL_FALLBACK' | 'LOCAL_DEPLOYMENT'
>;

/** The deployment chain's ID (31337 local, 84532 staging, 8453 production). */
export function chainIdOf(env: Pick<Env, 'CHAIN_ID'>): number {
  const id = Number(env.CHAIN_ID);
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('CHAIN_ID must be a chain ID');
  return id;
}

/**
 * The RPC transport: `BASE_RPC_URL`, falling back to `BASE_RPC_URL_FALLBACK` when it is set.
 * Throws when no provider is configured (a deployment error, never silently mocked).
 */
export function rpcTransport(env: ChainEnv): Transport {
  if (!env.BASE_RPC_URL) throw new Error('BASE_RPC_URL is not set');
  const primary = http(env.BASE_RPC_URL, { retryCount: 1, timeout: 10_000 });
  if (!env.BASE_RPC_URL_FALLBACK) return primary;
  return fallback([primary, http(env.BASE_RPC_URL_FALLBACK, { retryCount: 1, timeout: 10_000 })]);
}

/** A public client for the deployment chain; tests pass their own transport (a fake RPC). */
export function publicClient(env: ChainEnv, transport?: Transport): PublicClient {
  return createPublicClient({
    transport: transport ?? rpcTransport(env),
    // A cron tick or DO alarm makes a handful of calls; batching would only add latency.
    batch: { multicall: false },
    pollingInterval: 1_000,
  });
}

/** FlockedEscrow and FlockedAnchor on this chain (the local chain reads `LOCAL_DEPLOYMENT`). */
export function deploymentOf(env: Pick<Env, 'CHAIN_ID' | 'LOCAL_DEPLOYMENT'>): Deployment {
  const chainId = chainIdOf(env);
  const local =
    chainId === LOCAL_CHAIN_ID && env.LOCAL_DEPLOYMENT !== undefined
      ? (JSON.parse(env.LOCAL_DEPLOYMENT) as unknown)
      : undefined;
  return addressesFor(chainId, local);
}

/**
 * True when `address` has sent at least one transaction on this chain (spec "Anti-abuse" › Points
 * farming). An EOA's nonce counts its transactions. A smart wallet (Coinbase Smart Wallet) sends
 * through the EntryPoint, so its own nonce stays 0; it is deployed by its first user operation, so
 * deployed code counts as a prior transaction.
 */
export async function hasPriorTransaction(
  client: PublicClient,
  address: Address,
): Promise<boolean> {
  const [nonce, code] = await Promise.all([
    client.getTransactionCount({ address, blockTag: 'latest' }),
    client.getCode({ address, blockTag: 'latest' }),
  ]);
  return nonce > 0 || (code !== undefined && code !== '0x');
}
