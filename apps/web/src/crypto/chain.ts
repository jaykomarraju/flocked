// What the client trusts for a Free entry (spec "Sealed picks" › The client checks the target round):
// the drand chain it encrypts to, the deployment chain, the FlockedAnchor address and a public Base
// RPC the API does not control. None of it comes from the API.
//
// - Base and Base Sepolia: drand quicknet (`QUICKNET`, pinned in @flocked/tlock), the committed
//   deployment (@flocked/abi), and `VITE_PUBLIC_RPC_URL` or the chain's public RPC (viem's default).
// - The local chain (31337) is redeployed with a fresh drand network on every `pnpm stack:up`, so its
//   values exist only at run time: non-production builds read them from `window.__FLOCKED_LOCAL_CHAIN__`,
//   which the e2e specs set from the stack's state (e2e/ui/local-chain.ts). Production builds never
//   read it.
import { addressesFor, LOCAL_CHAIN_ID } from '@flocked/abi';
import { QUICKNET, type DrandChain } from '@flocked/tlock';
import type { Address } from 'viem';
import { appChain } from '../auth/config';

export interface ClientChain {
  chainId: number;
  /** A public RPC for the deployment chain (never the API). */
  rpcUrl: string;
  /** The FlockedAnchor address: the lock leaf, the receipt signer and the receipts' EIP-712 domain. */
  anchor: Address;
  drand: DrandChain;
}

/** The local stack's values, set by the e2e specs before the app loads (non-production builds only). */
export interface LocalChainGlobal {
  rpcUrl: string;
  anchor: Address;
  drand: DrandChain;
}

declare global {
  interface Window {
    __FLOCKED_LOCAL_CHAIN__?: LocalChainGlobal;
  }
  interface ImportMetaEnv {
    /** A public Base RPC for the client's onchain checks; the chain's default public RPC if unset. */
    readonly VITE_PUBLIC_RPC_URL?: string;
  }
}

/** Why the client can't check a round: this build or page has no trusted chain to check against. */
export class ChainConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainConfigError';
  }
}

/**
 * The trusted chain for this build. Throws `ChainConfigError` when there is none (a local build without
 * the stack's values, or a chain with no committed deployment yet): the entry flow then refuses to
 * encrypt rather than trust the API.
 */
export function clientChain(env: ImportMetaEnv = import.meta.env): ClientChain {
  const chain = appChain(env);
  if (chain.id === LOCAL_CHAIN_ID) {
    const local = env.MODE === 'production' ? undefined : window.__FLOCKED_LOCAL_CHAIN__;
    if (!local) throw new ChainConfigError('No local chain: start the stack and load its values');
    return { chainId: chain.id, rpcUrl: local.rpcUrl, anchor: local.anchor, drand: local.drand };
  }
  let anchor: Address;
  try {
    anchor = addressesFor(chain.id).anchor;
  } catch {
    throw new ChainConfigError(`No Flocked deployment on chain ${chain.id}`);
  }
  const rpcUrl = env.VITE_PUBLIC_RPC_URL || chain.rpcUrls.default.http[0];
  if (!rpcUrl) throw new ChainConfigError(`No public RPC for chain ${chain.id}`);
  return { chainId: chain.id, rpcUrl, anchor, drand: QUICKNET };
}
