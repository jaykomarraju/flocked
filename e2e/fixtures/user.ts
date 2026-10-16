// The `user` fixture (W7-D): a player as the API knows one. It signs in with SIWE (a new account,
// behind the Turnstile mock), verifies personhood through the Coinbase OAuth mock as its own
// Coinbase account (one person, one account), gets a Coinbase Verifications attestation for its
// wallet from the EAS mock, and accepts the Terms with the age `GET /me` asks for (`ageAttested`
// 18 | 21; W7-B). Each player has its own CF-Connecting-IP, which `wrangler dev` honours, so many
// sign-ins stay under the per-IP auth bucket.
import { randomInt, randomUUID } from 'node:crypto';
import {
  AuthSessionResponseSchema,
  MeResponseSchema,
  PersonhoodCallbackResponseSchema,
  SiweNonceResponseSchema,
  StartPersonhoodResponseSchema,
  type MeResponse,
} from '@flocked/shared';
import { createSiweMessage } from 'viem/siwe';
import { http } from './http';
import type { Stack } from './stack';
import { newWallet, type Wallet } from './wallet';

/** The dummy token Turnstile's test keys (and the stack's mock) accept. */
export const TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export interface User {
  userId: string;
  token: string;
  ip: string;
  wallet: Wallet;
}

// One /16 per run, so a spec never shares a rate-limit bucket with an earlier run on the same stack.
const IP_PREFIX = `10.${randomInt(64, 250)}`;
let ipCount = 0;

/** A fresh client IP for this run. */
export function nextIp(): string {
  ipCount += 1;
  return `${IP_PREFIX}.${Math.floor(ipCount / 250)}.${(ipCount % 250) + 1}`;
}

function ok<T>(what: string, res: { status: number; body: unknown }, status = 200): T {
  if (res.status !== status) {
    throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as T;
}

/** SIWE sign-in as a new account (the first sign-in passes Turnstile); a Bearer session. */
export async function signIn(stack: Stack, wallet: Wallet, ip = nextIp()): Promise<User> {
  const nonce = SiweNonceResponseSchema.parse(
    ok('SIWE nonce', await stack.api('/auth/siwe/nonce', { body: {}, ip })),
  );
  const origin = new URL(stack.appOrigin);
  const message = createSiweMessage({
    address: wallet.address,
    chainId: stack.chainId,
    domain: origin.host,
    nonce: nonce.nonce,
    uri: origin.origin,
    version: '1',
    issuedAt: new Date(),
  });
  const session = AuthSessionResponseSchema.parse(
    ok(
      'SIWE verify',
      await stack.api('/auth/siwe/verify', {
        ip,
        body: {
          message,
          signature: await wallet.account.signMessage({ message }),
          turnstileToken: TURNSTILE_TOKEN,
          transport: 'bearer',
        },
      }),
    ),
  );
  if (!session.token) throw new Error('SIWE verify answered no Bearer token');
  return { userId: session.user.id, token: session.token, ip, wallet };
}

/** Personhood through the Coinbase OAuth mock, as a new Coinbase account in `country`. */
export async function verifyPersonhood(
  stack: Stack,
  user: User,
  where: { country?: string; state?: string } = {},
): Promise<void> {
  const key = `e2e-${randomUUID()}`;
  ok(
    'Coinbase mock user',
    await http(`${stack.coinbaseUrl}/mock/users`, {
      body: { key, country: where.country ?? 'US', state: where.state ?? 'TX' },
    }),
  );
  const started = StartPersonhoodResponseSchema.parse(
    ok('POST /me/personhood', await stack.api('/me/personhood', { body: {}, ...auth(user) })),
  );
  const authorize = new URL(started.authorizeUrl);
  authorize.searchParams.set('mock_user', key);
  const approved = await fetch(authorize, { redirect: 'manual' });
  const location = approved.headers.get('location');
  if (approved.status !== 302 || !location) {
    throw new Error(`Coinbase mock authorize: HTTP ${approved.status}`);
  }
  const callback = new URL(location);
  // The callback consumes its OAuth state, so a retried GET would fail on a state already used.
  const outcome = await http(`${stack.apiUrl}${callback.pathname}${callback.search}`, {
    ...auth(user),
    headers: { accept: 'application/json' },
    idempotent: false,
  });
  const verified = PersonhoodCallbackResponseSchema.parse(ok('personhood callback', outcome));
  if (verified.status !== 'verified') {
    throw new Error(`personhood callback: ${JSON.stringify(verified)}`);
  }
  // Coinbase Verifications for the signed-in wallet (the EAS mock), which Stakes needs.
  ok(
    'EAS mock attestation',
    await http(`${stack.easUrl}/mock/verify`, {
      body: { recipient: user.wallet.lower, country: where.country ?? 'US' },
    }),
  );
}

/** Accepts the current Terms with the age the checkbox names for this player. */
export async function acceptTerms(stack: Stack, user: User): Promise<void> {
  const me = await getMe(stack, user);
  ok(
    'POST /me/tos',
    await stack.api('/me/tos', {
      body: { tosVersion: stack.tosVersion, ageAttested: me.tos.ageRequired },
      ...auth(user),
    }),
  );
}

export async function getMe(stack: Stack, user: User): Promise<MeResponse> {
  return MeResponseSchema.parse(ok('GET /me', await stack.api('/me', auth(user))));
}

/** The request options that act as this player. */
export function auth(user: User): { token: string; ip: string } {
  return { token: user.token, ip: user.ip };
}

/**
 * A new player: a fresh wallet, signed in. `stakes: true` also verifies personhood, attests the
 * wallet and accepts the Terms, so `GET /me` reports Stakes eligible.
 */
export async function newUser(stack: Stack, opts: { stakes?: boolean } = {}): Promise<User> {
  const user = await signIn(stack, await newWallet(stack));
  if (opts.stakes) {
    await verifyPersonhood(stack, user);
    await acceptTerms(stack, user);
    const me = await getMe(stack, user);
    if (!me.stakes.eligible) {
      throw new Error(`player not Stakes eligible: ${JSON.stringify(me.stakes.reasons)}`);
    }
  }
  return user;
}
