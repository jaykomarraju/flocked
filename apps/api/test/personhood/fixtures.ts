// Fakes for the personhood tests: a Coinbase that speaks the OAuth code flow with PKCE and the two
// v2 reads (same shapes as e2e/mocks/coinbase), an attestation chain (Coinbase's indexer and EAS
// behind a viem custom transport), and an env with the personhood vars and a throwaway key.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import {
  createClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  isAddressEqual,
  keccak256,
  toHex,
  zeroHash,
  type Address,
  type Client,
  type Hex,
} from 'viem';
import { EAS_ABI, INDEXER_ABI } from '../../src/personhood/attestations.js';
import { ATTESTATION_NETWORKS } from '../../src/personhood/config.js';
import { withPersonhoodDeps } from '../../src/personhood/deps.js';
import type { PersonhoodEnv } from '../../src/personhood/config.js';
import { authEnv, call, type TestAuth } from '../auth/fixtures.js';

/** Throwaway HMAC key for tests (32 bytes of hex), never a deployed value. */
export const TEST_PERSON_ID_KEY = `0x${'5e'.repeat(32)}`;
export const NET = ATTESTATION_NETWORKS.base;

/** One Coinbase account. `personal: null` = Coinbase returns no personal details (not ID-verified). */
export interface CoinbasePerson {
  id: string;
  name: string;
  email: string;
  personal: {
    legal_name: { first_name: string; last_name: string };
    address: {
      line1: string;
      city: string;
      state: string;
      postal_code: string;
      country_code: string;
    };
  } | null;
}

export function person(n: number, country = 'US', state = 'NJ'): CoinbasePerson {
  return {
    id: `0b5a7c1e-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: `Ada Lovelace ${n}`,
    email: `ada${n}@example.com`,
    personal: {
      legal_name: { first_name: 'Ada', last_name: `Lovelace${n}` },
      address: {
        line1: `${n} Analytical Engine Way`,
        city: 'Princeton',
        state,
        postal_code: `ZIP-Q${n}X`,
        country_code: country,
      },
    },
  };
}

const sha256b64url = async (s: string) => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  let bin = '';
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** An in-memory Coinbase: login.coinbase.com's authorize/token and api.coinbase.com's reads. */
export class FakeCoinbase {
  readonly clientId = 'test-client-id';
  readonly clientSecret = 'test-client-secret';
  private codes = new Map<
    string,
    { person: CoinbasePerson; challenge: string; redirect: string }
  >();
  private tokens = new Map<string, CoinbasePerson>();
  /** Every request, as `METHOD path`. */
  readonly calls: string[] = [];
  /** Make one step fail with this status. */
  failStep: { step: 'token' | 'user' | 'personal'; status: number } | null = null;

  /** The user approves `authorizeUrl` as `person`: returns the code Coinbase would redirect with. */
  approve(authorizeUrl: string, p: CoinbasePerson): string {
    const u = new URL(authorizeUrl);
    const code = `code-${crypto.randomUUID()}`;
    this.codes.set(code, {
      person: p,
      challenge: u.searchParams.get('code_challenge') ?? '',
      redirect: u.searchParams.get('redirect_uri') ?? '',
    });
    return code;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    if (method === 'POST' && url.pathname === '/oauth2/token') {
      if (this.failStep?.step === 'token')
        return new Response('{}', { status: this.failStep.status });
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      const entry = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const ok =
        entry &&
        form.get('grant_type') === 'authorization_code' &&
        form.get('client_id') === this.clientId &&
        form.get('client_secret') === this.clientSecret &&
        form.get('redirect_uri') === entry.redirect &&
        (await sha256b64url(form.get('code_verifier') ?? '')) === entry.challenge;
      if (!ok || !entry) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const token = `tok-${crypto.randomUUID()}`;
      this.tokens.set(token, entry.person);
      return Response.json({ access_token: token, token_type: 'bearer', expires_in: 3600 });
    }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const p = this.tokens.get(auth.replace(/^Bearer /, ''));
    if (!p) return Response.json({ errors: [{ id: 'invalid_token' }] }, { status: 401 });
    if (method === 'GET' && url.pathname === '/v2/user') {
      if (this.failStep?.step === 'user')
        return new Response('{}', { status: this.failStep.status });
      return Response.json({
        data: { id: p.id, name: p.name, username: null, email: p.email, resource: 'user' },
      });
    }
    if (method === 'GET' && url.pathname === '/v2/user/personal-details') {
      if (this.failStep?.step === 'personal') {
        return new Response('{}', { status: this.failStep.status });
      }
      if (!p.personal) return Response.json({ errors: [{ id: 'not_found' }] }, { status: 404 });
      return Response.json({ data: p.personal });
    }
    return new Response('not found', { status: 404 });
  };
}

interface Attestation {
  uid: Hex;
  schema: Hex;
  time: bigint;
  expirationTime: bigint;
  revocationTime: bigint;
  refUID: Hex;
  recipient: Address;
  attester: Address;
  revocable: boolean;
  data: Hex;
}

/** Coinbase's indexer and EAS on a fake chain, reachable through `client`. */
export class FakeAttestations {
  private latest = new Map<string, Hex>();
  private store = new Map<Hex, Attestation>();
  private n = 0;
  fail = false;
  readonly client: Client;

  constructor() {
    this.client = createClient({
      transport: custom({
        request: ({ method, params }: { method: string; params?: unknown }) => {
          if (this.fail) return Promise.reject(new Error('rpc down'));
          if (method === 'eth_chainId') return Promise.resolve(toHex(NET.chainId));
          if (method !== 'eth_call') return Promise.reject(new Error(`unexpected ${method}`));
          const { to, data } = (params as [{ to: Address; data: Hex }])[0];
          return Promise.resolve(this.call(to, data));
        },
      }),
    });
  }

  private call(to: Address, data: Hex): Hex {
    if (isAddressEqual(to, NET.indexer)) {
      const { args } = decodeFunctionData({ abi: INDEXER_ABI, data });
      const uid = this.latest.get(`${args[0].toLowerCase()}:${args[1]}`) ?? zeroHash;
      return encodeFunctionResult({
        abi: INDEXER_ABI,
        functionName: 'getAttestationUid',
        result: uid,
      });
    }
    if (isAddressEqual(to, NET.eas)) {
      const { args } = decodeFunctionData({ abi: EAS_ABI, data });
      const a = this.store.get(args[0]) ?? {
        uid: zeroHash,
        schema: zeroHash,
        time: 0n,
        expirationTime: 0n,
        revocationTime: 0n,
        refUID: zeroHash,
        recipient: '0x0000000000000000000000000000000000000000',
        attester: '0x0000000000000000000000000000000000000000',
        revocable: false,
        data: '0x',
      };
      return encodeFunctionResult({ abi: EAS_ABI, functionName: 'getAttestation', result: a });
    }
    throw new Error(`no contract at ${to}`);
  }

  /** Coinbase attests `wallet` (Verified Account, or Verified Country with `country`). */
  attest(
    wallet: Address,
    kind: 'account' | 'country',
    opts: { country?: string; attester?: Address; expirationTime?: bigint } = {},
  ): Hex {
    const schema = kind === 'account' ? NET.verifiedAccountSchema : NET.verifiedCountrySchema;
    const uid = keccak256(toHex(`att-${++this.n}`));
    const data =
      kind === 'account'
        ? encodeAbiParameters([{ type: 'bool' }], [true])
        : encodeAbiParameters([{ type: 'string' }], [opts.country ?? 'US']);
    this.store.set(uid, {
      uid,
      schema,
      time: 1n,
      expirationTime: opts.expirationTime ?? 0n,
      revocationTime: 0n,
      refUID: zeroHash,
      recipient: wallet,
      attester: opts.attester ?? NET.attester,
      revocable: true,
      data,
    });
    this.latest.set(`${wallet.toLowerCase()}:${schema}`, uid);
    return uid;
  }

  /** Both of Coinbase's attestations for `wallet`. */
  verify(wallet: Address, country: string): void {
    this.attest(wallet, 'account');
    this.attest(wallet, 'country', { country });
  }

  revoke(uid: Hex): void {
    const a = this.store.get(uid);
    if (a) a.revocationTime = 2n;
  }
}

export interface PersonhoodTest extends TestAuth {
  env: PersonhoodEnv;
  coinbase: FakeCoinbase;
  chain: FakeAttestations;
}

/** The sign-in env plus the personhood vars, a fake Coinbase and a fake attestation chain. */
export function personhoodEnv(vars: Partial<PersonhoodEnv> = {}): PersonhoodTest {
  const coinbase = new FakeCoinbase();
  const chain = new FakeAttestations();
  const t = authEnv({
    vars: {
      PERSON_ID_KEY: TEST_PERSON_ID_KEY,
      COINBASE_CLIENT_ID: coinbase.clientId,
      COINBASE_CLIENT_SECRET: coinbase.clientSecret,
      ...vars,
    },
  });
  withPersonhoodDeps(t.env, { coinbaseFetch: coinbase.fetch, attestationRpc: chain.client });
  return { ...t, coinbase, chain };
}

/** `POST /me/personhood` as the session in `headers`; returns the authorize URL and its state. */
export async function start(
  e: PersonhoodEnv,
  headers: Record<string, string>,
): Promise<{ url: string; state: string }> {
  const res = await call(e, 'POST', '/me/personhood', undefined, headers);
  if (res.status !== 200) throw new Error(`start: ${res.status} ${await res.text()}`);
  const { authorizeUrl } = await res.json<{ authorizeUrl: string }>();
  return { url: authorizeUrl, state: new URL(authorizeUrl).searchParams.get('state') ?? '' };
}

/** `GET /me/personhood/callback` with `params`, asking for the JSON outcome. */
export async function callback(
  e: PersonhoodEnv,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const qs = new URLSearchParams(params).toString();
  return call(e, 'GET', `/me/personhood/callback?${qs}`, undefined, {
    accept: 'application/json',
    ...headers,
  });
}

/** A bare account (as sign-up leaves it), created `createdAt`. */
export async function newUser(id: string, createdAt = Date.now()): Promise<void> {
  await env.DB.prepare('INSERT INTO users (id, ref_code, created_at) VALUES (?1, ?2, ?3)')
    .bind(id, `R${id.slice(-9)}`, createdAt)
    .run();
}

/** Links a verified wallet to `userId`. */
export async function linkWallet(userId: string, wallet: Address): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'wallet', ?3, ?4)",
  )
    .bind(newUlid(Date.now()), userId, wallet.toLowerCase(), Date.now())
    .run();
}
