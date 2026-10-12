// The signer's bindings, vars and its one secret (wrangler.jsonc). test/isolation.test.ts checks
// that the code reads nothing else from `env` and that TICKET_SIGNER_KEY is the only secret.

/** `ENVIRONMENT` var, as apps/api has it (plan 4.4). */
export type Environment = 'local' | 'staging' | 'production';

export interface Env {
  /** The API's D1, read only: src/store.ts runs its two SELECTs and nothing else. */
  DB: D1Database;
  ENVIRONMENT: Environment;
  /** 31337 local (anvil), 84532 staging (Base Sepolia), 8453 production (Base). */
  CHAIN_ID: string;
  /** Local only: the JSON of contracts/deployments/31337.json (public addresses, written by the stack). */
  LOCAL_DEPLOYMENT?: string;
  /** Secret: the FlockedEscrow ticket signer's private key (32 bytes of hex). */
  TICKET_SIGNER_KEY?: string;
}
