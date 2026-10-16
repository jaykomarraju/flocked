// Build-time settings for sign-in (Vite env; .env.e2e holds the local stack's). Production builds
// must set both: there is no fallback (plan.md 2.6, no mock on a production path).
import { base, baseSepolia, foundry, type Chain } from 'viem/chains';

const CHAINS: Record<number, Chain> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [foundry.id]: foundry,
};

/** The deployment chain: SIWE messages name it, and the API refuses any other (auth/siwe.ts). */
export function appChain(env: ImportMetaEnv = import.meta.env): Chain {
  const id = Number(env.VITE_CHAIN_ID ?? (env.PROD ? NaN : foundry.id));
  const chain = CHAINS[id];
  if (!chain) throw new Error(`VITE_CHAIN_ID must be one of ${Object.keys(CHAINS).join(', ')}`);
  return chain;
}

/** The Turnstile site key (public), or null when this build has none (dev). */
export function turnstileSiteKey(env: ImportMetaEnv = import.meta.env): string | null {
  const key = env.VITE_TURNSTILE_SITE_KEY;
  if (key) return key;
  if (env.PROD && env.MODE === 'production') throw new Error('VITE_TURNSTILE_SITE_KEY is required');
  return null;
}
