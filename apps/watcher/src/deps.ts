// Everything the tick reaches the outside world through, built from the watcher's own vars and
// secrets. Tests build a `WatcherDeps` by hand instead, exactly as `@flocked/verify`'s tests swap in
// a `ChainReader`.
import type { Deployment } from '@flocked/abi';
import { chainFromEnv, QUICKNET, type DrandChain } from '@flocked/tlock';
import {
  verifyRound,
  type ChainReader,
  type Report,
  type VerifyRoundOptions,
} from '@flocked/verify';
import { z } from 'zod';
import { apiClient, type ApiClient } from './api.js';
import { ATTESTATION_NETWORKS, attestationReader, type AttestationReader } from './attest.js';
import { deploymentFor, verifyReader, watcherChain, type WatcherChain } from './chain.js';
import { countryAllow, isLocal, type Env } from './env.js';

export interface WatcherDeps {
  api: ApiClient;
  chain: WatcherChain;
  /** `@flocked/verify`'s reader, on the watcher's own RPC. */
  reader: ChainReader;
  attestations: AttestationReader;
  drand: DrandChain;
  deployment: Deployment;
  chainId: number;
  /** The public API base the bundles are read from (`bundleBaseUrl`). */
  bundleBaseUrl: string;
  rpcUrl: string;
  countryAllow: string[];
  verify: (o: VerifyRoundOptions) => Promise<Report>;
  fetch: typeof fetch;
}

const DrandInfoSchema = z.looseObject({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  public_key: z.string().regex(/^[0-9a-f]{192}$/),
  genesis_time: z.number().int().nonnegative(),
  period: z.number().int().positive(),
  schemeID: z.literal('bls-unchained-g1-rfc9380'),
});

/**
 * The drand chain the picks target. Staging and production use the pinned `DRAND_*` vars, or
 * quicknet when none is set (`chainFromEnv`). Only `local` may take the chain from `DRAND_INFO_URL`,
 * because the stack's drand network has a fresh key every run; trusting a URL for a public key
 * would otherwise let whoever serves it change what "verified" means.
 */
export async function drandFor(env: Env, fetchImpl: typeof fetch = fetch): Promise<DrandChain> {
  if (isLocal(env) && env.DRAND_INFO_URL) {
    const res = await fetchImpl(env.DRAND_INFO_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`drand info: HTTP ${res.status}`);
    const info = DrandInfoSchema.parse(await res.json());
    return {
      chainHash: info.hash,
      publicKey: info.public_key,
      scheme: info.schemeID,
      genesis: info.genesis_time,
      period: info.period,
    };
  }
  return chainFromEnv(env as unknown as Record<string, string | undefined>);
}

/** The attestation network and the RPC that serves it (Base mainnet even when the game is on Sepolia). */
export function attestationTarget(env: Env): {
  network: typeof ATTESTATION_NETWORKS.base;
  rpcUrl: string;
} {
  const name = env.ATTESTATION_NETWORK ?? 'base';
  const network = ATTESTATION_NETWORKS[name];
  const rpcUrl =
    env.ATTESTATION_RPC_URL ??
    (Number(env.CHAIN_ID) === network.chainId ? env.BASE_RPC_URL : undefined) ??
    '';
  return { network, rpcUrl };
}

export async function depsFor(env: Env, fetchImpl: typeof fetch = fetch): Promise<WatcherDeps> {
  const chainId = Number(env.CHAIN_ID);
  const deployment = deploymentFor(chainId, env.LOCAL_DEPLOYMENT);
  const drand = await drandFor(env, fetchImpl);
  const target = attestationTarget(env);
  const reader = verifyReader(env.BASE_RPC_URL, deployment);
  return {
    api: apiClient(env.API_BASE_URL, { fetch: fetchImpl }),
    chain: watcherChain({ rpcUrl: env.BASE_RPC_URL, deployment }),
    reader,
    attestations: target.rpcUrl
      ? attestationReader({ rpcUrl: target.rpcUrl, network: target.network })
      : () => Promise.reject(new Error('no attestation RPC is configured')),
    drand,
    deployment,
    chainId,
    bundleBaseUrl: env.API_BASE_URL,
    rpcUrl: env.BASE_RPC_URL,
    countryAllow: countryAllow(env),
    verify: verifyRound,
    fetch: fetchImpl,
  };
}

export { QUICKNET };
