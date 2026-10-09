// External services sign-in depends on: the chain RPC (ERC-1271 / ERC-6492 signatures), Farcaster's
// Quick Auth keys, the email sender and Turnstile's fetch. `authDeps(env)` builds the real ones;
// tests register fakes for one env object with `withAuthDeps`, so production never falls back to a
// fake (plan 2.6).
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { createClient, custom, fallback, http, type Client } from 'viem';
import type { Env } from '../env.js';
import { emailFrom, farcasterAuthOrigin } from './config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends one transactional email. Rejects when the provider refuses it. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface AuthDeps {
  /** Chain RPC for smart-wallet signatures; EOA signatures verify without it. */
  rpc: Client;
  /** Quick Auth signing keys (Farcaster's JWKS). */
  farcasterKeys: JWTVerifyGetKey;
  email: EmailSender;
  /** `fetch` for Turnstile siteverify (src/lib/turnstile.ts). */
  turnstileFetch: typeof fetch;
}

const overrides = new WeakMap<object, Partial<AuthDeps>>();

/** Test hook: a copy of `env` whose auth dependencies are `deps` (the rest stay real). */
export function withAuthDeps<E extends Env>(env: E, deps: Partial<AuthDeps>): E {
  const copy = { ...env };
  overrides.set(copy, { ...overrides.get(env), ...deps });
  return copy;
}

/** RPC unavailable: viem's verifyHash still ecrecovers EOA signatures, then reports this error. */
const noRpc = custom({
  request: () => Promise.reject(new Error('no RPC configured (BASE_RPC_URL)')),
});

const rpcClients = new Map<string, Client>();
const jwksSets = new Map<string, JWTVerifyGetKey>();

function rpcClient(env: Pick<Env, 'BASE_RPC_URL' | 'BASE_RPC_URL_FALLBACK'>): Client {
  const urls = [env.BASE_RPC_URL, env.BASE_RPC_URL_FALLBACK].filter((u): u is string => !!u);
  const key = urls.join(' ');
  let client = rpcClients.get(key);
  if (!client) {
    const transport = urls.length === 0 ? noRpc : fallback(urls.map((u) => http(u)));
    client = createClient({ transport });
    rpcClients.set(key, client);
  }
  return client;
}

/** One cached JWKS per origin, so keys are fetched once per isolate (jose refreshes on unknown kid). */
function farcasterKeys(env: Pick<Env, 'ENVIRONMENT' | 'FARCASTER_AUTH_ORIGIN'>): JWTVerifyGetKey {
  const origin = farcasterAuthOrigin(env);
  let keys = jwksSets.get(origin);
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/.well-known/jwks.json', origin));
    jwksSets.set(origin, keys);
  }
  return keys;
}

/** Sends through the `send_email` binding (Cloudflare Email Sending). */
export function bindingEmailSender(env: Pick<Env, 'EMAIL' | 'EMAIL_FROM'>): EmailSender {
  return {
    async send({ to, subject, text }) {
      await env.EMAIL.send({ from: emailFrom(env), to, subject, text });
    },
  };
}

export function authDeps(env: Env): AuthDeps {
  const o = overrides.get(env) ?? {};
  return {
    rpc: o.rpc ?? rpcClient(env),
    farcasterKeys: o.farcasterKeys ?? farcasterKeys(env),
    email: o.email ?? bindingEmailSender(env),
    turnstileFetch: o.turnstileFetch ?? ((input, init) => fetch(input, init)),
  };
}
