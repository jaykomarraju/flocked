// The watcher's bindings, vars and secrets (wrangler.jsonc). It runs in a second Cloudflare account
// (plan.md 4.4, OA-05), so nothing here reaches the backend: no R2, no KV, no service binding, and
// the one D1 is the watcher's own. test/isolation.test.ts checks that.

/** `ENVIRONMENT` var, as apps/api has it (plan.md 4.4). */
export type Environment = 'local' | 'staging' | 'production';

export interface Env {
  /** The watcher's own D1 (migrations/), never the API's. */
  DB: D1Database;
  ENVIRONMENT: Environment;
  /** 31337 local (anvil), 84532 staging (Base Sepolia), 8453 production (Base). */
  CHAIN_ID: string;
  /**
   * The Flocked API's public base, version path included (`https://flocked.xyz/api/v1`). The watcher
   * reads only public routes from it, and passes the same base to `@flocked/verify` as
   * `bundleBaseUrl` (`GET /rounds/:id/bundles/:mode/:file`).
   */
  API_BASE_URL: string;
  /** The watcher's own Base RPC. Never the backend's provider or key. */
  BASE_RPC_URL: string;
  /** Coinbase Verifications network: attestations live on Base mainnet even on staging. */
  ATTESTATION_NETWORK?: 'base' | 'base-sepolia';
  /** The attestation network's RPC; defaults to BASE_RPC_URL when the chains match. */
  ATTESTATION_RPC_URL?: string;
  /**
   * Verified Country codes a question author may hold, comma-separated (legal's list, OA-21). Empty
   * or unset means the watcher cannot judge a creator's country: the check reports `unable`.
   */
  COUNTRY_ALLOW?: string;
  /** drand chain, for a chain that is not quicknet (@flocked/tlock `chainFromEnv`). */
  DRAND_CHAIN_HASH?: string;
  DRAND_PUBLIC_KEY?: string;
  DRAND_GENESIS?: string;
  DRAND_PERIOD?: string;
  /** Local only: the local drand network's `/info`, read at each tick (the stack's keys are fresh). */
  DRAND_INFO_URL?: string;
  /** Local only: the JSON of contracts/deployments/31337.json (public addresses from the stack). */
  LOCAL_DEPLOYMENT?: string;
  /** Secret: the verdict signing key, 32 bytes of hex (OA-15). */
  WATCHER_KEY?: string;
  /** Secret: the guardian paging webhook (OA-18). A capability URL, so never logged. */
  PAGER_WEBHOOK_URL?: string;
  /** Secret: optional bearer token for that webhook. */
  PAGER_WEBHOOK_TOKEN?: string;
}

export const isLocal = (env: Pick<Env, 'ENVIRONMENT'>): boolean => env.ENVIRONMENT === 'local';

/** The allowed Verified Country codes, or an empty array when the owner has set none. */
export function countryAllow(env: Pick<Env, 'COUNTRY_ALLOW'>): string[] {
  return (env.COUNTRY_ALLOW ?? '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
}
