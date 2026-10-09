// Shared fakes for the sign-in tests: an env with the sign-in vars, a mock chain RPC, a local Quick
// Auth signer and JWKS, a capturing email sender and notify queue, and a request helper that goes
// through the real app (session middleware included).
import { env } from 'cloudflare:test';
import type { NotifyMessage } from '@flocked/shared';
import { API_BASE_PATH } from '@flocked/shared';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createClient, custom, type Address, type Client, type Hex } from 'viem';
import type { LocalAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { app } from '../../src/app.js';
import { FARCASTER_AUTH_ORIGIN } from '../../src/auth/config.js';
import { withAuthDeps, type AuthDeps, type EmailMessage } from '../../src/auth/deps.js';
import type { Env } from '../../src/env.js';

export const ORIGIN = 'https://flocked.test';
export const HOST = 'flocked.test';
export const TOS = '2026-10-01';
export const CHAIN_ID = Number(env.CHAIN_ID);
const FALSE_WORD = `0x${'0'.repeat(64)}` as const;
const TRUE_WORD = `0x${'0'.repeat(63)}1` as const;

/** Captures sent emails; `codes` are the 8-digit codes found in them, in order. */
export class MemoryEmailSender {
  readonly sent: EmailMessage[] = [];
  fail = false;
  send(message: EmailMessage): Promise<void> {
    if (this.fail) return Promise.reject(new Error('provider refused'));
    this.sent.push(message);
    return Promise.resolve();
  }
  get codes(): string[] {
    return this.sent.map((m) => /\b(\d{8})\b/.exec(m.text)?.[1] ?? '');
  }
}

/** Captures notify-queue messages. */
export class MemoryQueue {
  readonly messages: NotifyMessage[] = [];
  send(message: NotifyMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }
  sendBatch(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }
}

/**
 * A mock chain: `eth_call` answers with `onCall(data)` (true/false for the ERC-6492 universal
 * validator); `fail` makes every request reject, like an RPC outage.
 */
export function mockRpc(
  onCall: (data: Hex) => boolean = () => false,
  opts: { fail?: boolean } = {},
): Client & { calls: Hex[] } {
  const calls: Hex[] = [];
  const client = createClient({
    transport: custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        if (opts.fail) return Promise.reject(new Error('rpc down'));
        if (method === 'eth_chainId') return Promise.resolve(`0x${CHAIN_ID.toString(16)}`);
        if (method === 'eth_call') {
          const data = ((params as [{ data: Hex }])[0]?.data ?? '0x').toLowerCase() as Hex;
          calls.push(data);
          return Promise.resolve(onCall(data) ? TRUE_WORD : FALSE_WORD);
        }
        return Promise.reject(new Error(`unexpected ${method}`));
      },
    }),
  });
  return Object.assign(client, { calls });
}

export interface QuickAuthSigner {
  keys: AuthDeps['farcasterKeys'];
  jwk: JWK;
  mint(
    fid: number | string,
    opts?: { aud?: string; iss?: string; expSec?: number; iatSec?: number },
  ): Promise<string>;
}

/** A local Quick Auth server: an RS256 key, its JWKS, and tokens shaped like Farcaster's. */
export async function quickAuthSigner(kid = 'test-key'): Promise<QuickAuthSigner> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid };
  const keys = createLocalJWKSet({ keys: [jwk] });
  return {
    keys,
    jwk,
    async mint(fid, opts = {}) {
      const iat = opts.iatSec ?? Math.floor(Date.now() / 1000);
      return new SignJWT({ sub: String(fid) })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(opts.iss ?? FARCASTER_AUTH_ORIGIN)
        .setAudience(opts.aud ?? HOST)
        .setIssuedAt(iat)
        .setExpirationTime(opts.expSec ?? iat + 3600)
        .sign(privateKey);
    },
  };
}

export interface TestAuth {
  env: Env;
  email: MemoryEmailSender;
  notify: MemoryQueue;
  turnstileCalls: number;
}

/**
 * The sign-in env: the vars sign-in needs, a passing (or failing) Turnstile, captured emails and
 * notices, and the given RPC and Quick Auth keys.
 */
export function authEnv(
  opts: {
    rpc?: Client;
    farcasterKeys?: AuthDeps['farcasterKeys'];
    turnstile?: boolean;
    vars?: Partial<Env>;
  } = {},
): TestAuth {
  const email = new MemoryEmailSender();
  const notify = new MemoryQueue();
  const state: TestAuth = { env: env, email, notify, turnstileCalls: 0 };
  const base: Env = {
    ...(env as Env),
    APP_ORIGIN: ORIGIN,
    TOS_VERSION: TOS,
    EMAIL_FROM: 'codes@flocked.test',
    QUEUE_NOTIFY: notify as unknown as Env['QUEUE_NOTIFY'],
    ...opts.vars,
  };
  state.env = withAuthDeps(base, {
    rpc: opts.rpc ?? mockRpc(),
    email,
    ...(opts.farcasterKeys ? { farcasterKeys: opts.farcasterKeys } : {}),
    turnstileFetch: () => {
      state.turnstileCalls++;
      return Promise.resolve(Response.json({ success: opts.turnstile ?? true }));
    },
  });
  return state;
}

let ipCounter = 0;

/** A distinct private-range IP per call, so per-IP limits only bite where a test sets one. */
function nextIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

/**
 * A JSON request through the real app (session middleware, routes, error envelope). Each call
 * comes from its own IP unless `headers` sets `CF-Connecting-IP`.
 */
export async function call(
  e: Env,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: { 'CF-Connecting-IP': nextIp(), ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  return app.request(`${ORIGIN}${API_BASE_PATH}${path}`, init, e);
}

/** The error code of an error-envelope response. */
export async function errorCode(res: Response): Promise<string> {
  const body: { error?: { code?: string } } = await res.json();
  return body.error?.code ?? `<no envelope: ${res.status}>`;
}

/** A fresh nonce from the API. */
export async function nonce(e: Env, headers: Record<string, string> = {}): Promise<string> {
  const res = await call(e, 'POST', '/auth/siwe/nonce', undefined, headers);
  if (res.status !== 200) throw new Error(`nonce: ${res.status}`);
  return (await res.json<{ nonce: string }>()).nonce;
}

/** An EIP-4361 message for this app; any field can be overridden. */
export function siweMessage(
  address: Address,
  nonceValue: string,
  over: Partial<Parameters<typeof createSiweMessage>[0]> = {},
): string {
  return createSiweMessage({
    address,
    chainId: CHAIN_ID,
    domain: HOST,
    nonce: nonceValue,
    uri: `${ORIGIN}/`,
    version: '1',
    issuedAt: new Date(),
    statement: 'Sign in to Flocked',
    ...over,
  });
}

/** Signs a fresh SIWE message with an EOA and returns the verify body. */
export async function siweBody(
  e: Env,
  account: LocalAccount,
  extra: Record<string, unknown> = {},
  over: Partial<Parameters<typeof createSiweMessage>[0]> = {},
): Promise<{ message: string; signature: Hex } & Record<string, unknown>> {
  const message = siweMessage(account.address, await nonce(e), over);
  return { message, signature: await account.signMessage({ message }), ...extra };
}

/** The `Set-Cookie` value for the session cookie, if any. */
export function sessionSetCookie(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => /flocked_session=/.test(c)) ?? null;
}

/** `Cookie` request header from a sign-in response. */
export function cookieFrom(res: Response): Record<string, string> {
  const set = sessionSetCookie(res);
  if (!set) throw new Error('no session cookie');
  return { Cookie: set.split(';')[0] as string };
}
