// Coinbase sign-in for personhood (spec "Identity and personhood" › Personhood): the authorize URL
// with PKCE (S256), the code exchange, and the two reads. Payloads are never logged: they hold the
// Coinbase user ID, legal name and address, none of which may be stored or logged (NFR-8). Only
// the country and region codes leave this file, plus the raw ID, which the caller HMACs at once.
//
// Response shapes. `/v2/user` is Coinbase's documented `{ data: { id, ... } }`. The shape of
// `/v2/user/personal-details` is not publicly documented (launch gate 2; OA-22 confirmed only that
// it answers for ID-verified accounts), so `parsePersonalDetails` is the one place that reads it:
// the country from `data.address.country_code` (or `country` as a code or `{ code }`), and the
// region from `data.address.state` (or `region`). e2e/mocks/coinbase serves the same shape.
import { z } from 'zod';
import { randomToken } from '../auth/crypto.js';
import { log } from '../lib/log.js';
import {
  COINBASE_API_VERSION,
  COINBASE_AUTHORIZE_PATH,
  COINBASE_SCOPES,
  COINBASE_TOKEN_PATH,
  coinbaseApiOrigin,
  coinbaseClient,
  coinbaseLoginOrigin,
  personIdKey,
  personhoodRedirectUri,
  type PersonhoodEnv,
} from './config.js';
import { personhoodDeps } from './deps.js';

/** A Coinbase call failed in a way that says nothing about the user (network, 5xx, bad token). */
export class CoinbaseError extends Error {
  constructor(readonly step: 'token' | 'user' | 'personal_details') {
    super(`coinbase ${step} failed`);
  }
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A PKCE verifier (43 characters, RFC 7636) and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** The Coinbase authorize URL for one started flow. */
export function authorizeUrl(env: PersonhoodEnv, state: string, challenge: string): string {
  const url = new URL(COINBASE_AUTHORIZE_PATH, coinbaseLoginOrigin(env));
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: coinbaseClient(env).id,
    redirect_uri: personhoodRedirectUri(env),
    scope: COINBASE_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

const TokenSchema = z.object({ access_token: z.string().min(1) });

/** Exchanges the code for an access token. The token lives only in this request. */
export async function exchangeCode(
  env: PersonhoodEnv,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const client = coinbaseClient(env);
  const res = await personhoodDeps(env)
    .coinbaseFetch(new URL(COINBASE_TOKEN_PATH, coinbaseLoginOrigin(env)), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: personhoodRedirectUri(env),
        code_verifier: codeVerifier,
      }).toString(),
    })
    .catch(() => null);
  if (!res?.ok) return fail('token', res);
  const parsed = TokenSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return fail('token', res);
  return parsed.data.access_token;
}

function fail(step: CoinbaseError['step'], res: Response | null): never {
  // The status only: bodies may echo the code or user data.
  log.warn('coinbase_call_failed', { step, status: res?.status ?? null });
  throw new CoinbaseError(step);
}

async function apiGet(env: PersonhoodEnv, path: string, token: string): Promise<Response | null> {
  return personhoodDeps(env)
    .coinbaseFetch(new URL(path, coinbaseApiOrigin(env)), {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'cb-version': COINBASE_API_VERSION,
      },
    })
    .catch(() => null);
}

const UserSchema = z.object({ data: z.object({ id: z.string().min(1).max(128) }) });

/** `GET /v2/user`: the Coinbase user ID (raw; HMAC it with `personIdFor` and drop it). */
export async function fetchCoinbaseUserId(env: PersonhoodEnv, token: string): Promise<string> {
  const res = await apiGet(env, '/v2/user', token);
  if (!res?.ok) return fail('user', res);
  const parsed = UserSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return fail('user', res);
  return parsed.data.data.id;
}

/** What personhood keeps from the personal details: the country and region codes only. */
export interface PersonLocation {
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string;
  /** ISO 3166-2 subdivision code without the country prefix (`NY` for `US-NY`), or null. */
  region: string | null;
}

const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z0-9]{1,3}$/;

function code(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().toUpperCase();
  if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string') {
    return value.code.trim().toUpperCase();
  }
  return null;
}

/**
 * The country and region from a personal-details body, or null when it carries no usable address
 * country (which means "not ID-verified"). Everything else in the body is ignored.
 */
export function parsePersonalDetails(body: unknown): PersonLocation | null {
  if (!body || typeof body !== 'object' || !('data' in body)) return null;
  const data = body.data;
  if (!data || typeof data !== 'object' || !('address' in data)) return null;
  const address = data.address;
  if (!address || typeof address !== 'object') return null;
  const a = address as Record<string, unknown>;
  const country = code(a.country_code ?? a.country);
  if (!country || !COUNTRY.test(country)) return null;
  let region = code(a.state ?? a.region);
  if (region?.startsWith(`${country}-`)) region = region.slice(country.length + 1);
  return { country, region: region && REGION.test(region) ? region : null };
}

/**
 * `GET /v2/user/personal-details`: the address's country and region, or null when Coinbase returns
 * no personal details (403, 404, or a body without an address country). Spec: `kyc_status =
 * verified` only if personal details are returned. Other failures throw: they say nothing about
 * the user, so they must not downgrade a verification.
 */
export async function fetchPersonLocation(
  env: PersonhoodEnv,
  token: string,
): Promise<PersonLocation | null> {
  const res = await apiGet(env, '/v2/user/personal-details', token);
  if (res && (res.status === 403 || res.status === 404)) return null;
  if (!res?.ok) return fail('personal_details', res);
  return parsePersonalDetails(await res.json().catch(() => null));
}

/** `person_id` = HMAC-SHA256(PERSON_ID_KEY, Coinbase user ID), as lowercase 0x hex. */
export async function personIdFor(env: PersonhoodEnv, coinbaseUserId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    personIdKey(env),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(coinbaseUserId)));
  return `0x${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
