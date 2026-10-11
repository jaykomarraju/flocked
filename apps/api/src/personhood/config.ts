// Personhood configuration (spec "Identity and personhood" › Personhood): Coinbase OAuth endpoints and
// scopes, the Coinbase Verifications attestation constants, and the vars and secrets that select
// them. A missing secret or var is a deployment error: the routes that need it answer 503
// `unavailable` and log which one is missing (as src/auth/config.ts does).
//
// The vars below are not in src/env.ts yet (a registry file, W5-D's): `PersonhoodEnv` adds them as
// optional fields so this module reads them typed. W5-B's handoff lists them for D.
import { API_BASE_PATH } from '@flocked/shared';
import type { Address, Hex } from 'viem';
import { appOrigin } from '../auth/config.js';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';

/** Env as this module reads it: the Worker's, plus the personhood vars D adds to src/env.ts. */
export type PersonhoodEnv = Env & {
  /**
   * Coinbase Verifications network: `base` (default; Coinbase's production attester, which is where
   * real users' attestations live, staging included) or `base-sepolia` (Coinbase's test attester).
   */
  ATTESTATION_NETWORK?: string;
  /** JSON-RPC for that network. Defaults to BASE_RPC_URL when CHAIN_ID is 8453. */
  ATTESTATION_RPC_URL?: string;
  /** Coinbase OAuth origin override (e2e/mocks/coinbase); honoured only when ENVIRONMENT is 'local'. */
  COINBASE_LOGIN_ORIGIN?: string;
  /** Coinbase API origin override (e2e/mocks/coinbase); honoured only when ENVIRONMENT is 'local'. */
  COINBASE_API_ORIGIN?: string;
};

/** Coinbase App OAuth 2.0 (docs.cdp.coinbase.com › Coinbase App › OAuth2 integration). */
export const COINBASE_LOGIN_ORIGIN = 'https://login.coinbase.com';
export const COINBASE_AUTHORIZE_PATH = '/oauth2/auth';
export const COINBASE_TOKEN_PATH = '/oauth2/token';
/** Coinbase API v2: `GET /v2/user`, `GET /v2/user/personal-details`. */
export const COINBASE_API_ORIGIN = 'https://api.coinbase.com';
/** Pinned API version header for the v2 API. */
export const COINBASE_API_VERSION = '2026-10-01';
/** Spec "Personhood" › Flow. Space-separated in the authorize URL (OAuth 2.0). */
export const COINBASE_SCOPES = ['wallet:user:read', 'identity:user:address:read'] as const;

/** How long a started Coinbase sign-in may take before its state expires. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** One Coinbase Verifications deployment (github.com/coinbase/verifications, README). */
export interface AttestationNetwork {
  name: 'base' | 'base-sepolia';
  chainId: number;
  /** EAS predeploy. */
  eas: Address;
  /** Coinbase's indexer: `getAttestationUid(recipient, schemaUid) → bytes32`. */
  indexer: Address;
  /** Coinbase's attester; attestations from anyone else are ignored. */
  attester: Address;
  /** `bool verifiedAccount` (always true). */
  verifiedAccountSchema: Hex;
  /** `string verifiedCountry` (ISO 3166-1 alpha-2). */
  verifiedCountrySchema: Hex;
}

export const ATTESTATION_NETWORKS: Record<AttestationNetwork['name'], AttestationNetwork> = {
  base: {
    name: 'base',
    chainId: 8453,
    eas: '0x4200000000000000000000000000000000000021',
    indexer: '0x2c7eE1E5f416dfF40054c27A62f7B357C4E8619C',
    attester: '0x357458739F90461b99789350868CD7CF330Dd7EE',
    verifiedAccountSchema: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
    verifiedCountrySchema: '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065',
  },
  'base-sepolia': {
    name: 'base-sepolia',
    chainId: 84532,
    eas: '0x4200000000000000000000000000000000000021',
    indexer: '0xd147a19c3B085Fb9B0c15D2EAAFC6CB086ea849B',
    attester: '0xB5644397a9733f86Cacd928478B29b4cD6041C45',
    verifiedAccountSchema: '0x2f34a2ffe5f87b2f45fbc7c784896b768d77261e2f24f77341ae43751c765a69',
    verifiedCountrySchema: '0xef54ae90f47a187acc050ce631c55584fd4273c0ca9456ab21750921c3a84028',
  },
};

function missing(name: string): never {
  log.error('personhood_config_missing', { var: name });
  throw new HttpError('unavailable', 'Coinbase verification is not configured');
}

const isLocal = (env: Pick<Env, 'ENVIRONMENT'>) => env.ENVIRONMENT === 'local';

export function coinbaseLoginOrigin(env: PersonhoodEnv): string {
  return isLocal(env) && env.COINBASE_LOGIN_ORIGIN
    ? env.COINBASE_LOGIN_ORIGIN
    : COINBASE_LOGIN_ORIGIN;
}

export function coinbaseApiOrigin(env: PersonhoodEnv): string {
  return isLocal(env) && env.COINBASE_API_ORIGIN ? env.COINBASE_API_ORIGIN : COINBASE_API_ORIGIN;
}

export function coinbaseClient(env: PersonhoodEnv): { id: string; secret: string } {
  return {
    id: env.COINBASE_CLIENT_ID || missing('COINBASE_CLIENT_ID'),
    secret: env.COINBASE_CLIENT_SECRET || missing('COINBASE_CLIENT_SECRET'),
  };
}

/** The registered redirect URI: the callback route on the app's origin (OA-09 registers it). */
export function personhoodRedirectUri(env: PersonhoodEnv): string {
  return `${appOrigin(env).origin}${API_BASE_PATH}/me/personhood/callback`;
}

/** Where the callback sends the browser afterwards: Settings, which shows the outcome. */
export function personhoodReturnUrl(env: PersonhoodEnv): string {
  return `${appOrigin(env).origin}/settings`;
}

/**
 * `PERSON_ID_KEY` as raw key bytes: 32 or more bytes of hex (`openssl rand -hex 32`), with or
 * without `0x`. It cannot be rotated (raw Coinbase IDs are not stored), so a malformed value is a
 * deployment error rather than something to work around.
 */
export function personIdKey(env: PersonhoodEnv): Uint8Array {
  const raw = (env.PERSON_ID_KEY ?? '').replace(/^0x/, '');
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(raw)) return missing('PERSON_ID_KEY');
  const bytes = new Uint8Array(raw.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function attestationNetwork(env: PersonhoodEnv): AttestationNetwork {
  const name = env.ATTESTATION_NETWORK || 'base';
  if (name !== 'base' && name !== 'base-sepolia') return missing('ATTESTATION_NETWORK');
  return ATTESTATION_NETWORKS[name];
}

/** The attestation network's RPC URLs, or none (lookups then fail closed). */
export function attestationRpcUrls(env: PersonhoodEnv): string[] {
  if (env.ATTESTATION_RPC_URL) return [env.ATTESTATION_RPC_URL];
  // The game chain's RPC serves attestations only when the game chain is the attestation network.
  if (Number(env.CHAIN_ID) === attestationNetwork(env).chainId) {
    return [env.BASE_RPC_URL, env.BASE_RPC_URL_FALLBACK].filter((u): u is string => !!u);
  }
  return [];
}
