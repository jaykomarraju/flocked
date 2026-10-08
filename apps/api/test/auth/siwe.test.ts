// SIWE sign-in: nonces, replay, domain/URI/chain checks, EOA, ERC-1271 and ERC-6492 signatures,
// account creation behind Turnstile with the signup grant.
import { env } from 'cloudflare:test';
import { AuthSessionResponseSchema, SiweNonceResponseSchema } from '@flocked/shared';
import { serializeErc6492Signature, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { nonceHash } from '../../src/auth/siwe.js';
import { nonceKvKey } from '../../src/do/auth-do.js';
import { balanceOf, ledgerCount, seedFixture, FIXTURE_IDS } from '../helpers/index.js';
import {
  CHAIN_ID,
  authEnv,
  call,
  errorCode,
  mockRpc,
  nonce,
  sessionSetCookie,
  siweBody,
  siweMessage,
} from './fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

const newAccount = () => privateKeyToAccount(generatePrivateKey());

async function identityOwner(address: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT user_id FROM identities WHERE provider = 'wallet' AND external_id = ?1",
  )
    .bind(address.toLowerCase())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

describe('POST /auth/siwe/nonce', () => {
  it('issues a single-use nonce stored only as a hash in KV, with a 5-minute TTL', async () => {
    const { env: e } = authEnv();
    const res = await call(e, 'POST', '/auth/siwe/nonce');
    expect(res.status).toBe(200);
    const body = SiweNonceResponseSchema.parse(await res.json());
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.expiresAt - Date.now()).toBeGreaterThan(290_000);
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(300_000);
    expect(await env.KV.get(nonceKvKey(await nonceHash(body.nonce)))).not.toBeNull();
    const keys = await env.KV.list({ prefix: 'auth:nonce:' });
    expect(keys.keys.some((k) => k.name.includes(body.nonce))).toBe(false);
  });
});

describe('POST /auth/siwe/verify', () => {
  it('creates an account for a new wallet behind Turnstile, with the 500-point signup grant', async () => {
    const t = authEnv();
    const account = newAccount();
    const res = await call(
      t.env,
      'POST',
      '/auth/siwe/verify',
      await siweBody(t.env, account, { turnstileToken: 'tok' }),
    );
    expect(res.status).toBe(200);
    const body = AuthSessionResponseSchema.parse(await res.json());
    expect(body.created).toBe(true);
    expect(body.token).toBeNull();
    expect(body.user.handle).toBeNull();
    expect(t.turnstileCalls).toBe(1);
    expect(await identityOwner(account.address)).toBe(body.user.id);
    expect(await balanceOf(env.DB, body.user.id)).toBe(500);
    const ledger = await env.DB.prepare(
      'SELECT reason, ref_id, delta FROM points_ledger WHERE user_id = ?1',
    )
      .bind(body.user.id)
      .all();
    expect(ledger.results).toEqual([{ reason: 'signup', ref_id: body.user.id, delta: 500 }]);

    const cookie = sessionSetCookie(res);
    expect(cookie).toMatch(/^flocked_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
  });

  it('signs in to the existing account without Turnstile and without a second grant', async () => {
    const t = authEnv();
    const account = newAccount();
    const first = AuthSessionResponseSchema.parse(
      await (
        await call(
          t.env,
          'POST',
          '/auth/siwe/verify',
          await siweBody(t.env, account, { turnstileToken: 'tok' }),
        )
      ).json(),
    );
    const res = await call(t.env, 'POST', '/auth/siwe/verify', await siweBody(t.env, account));
    expect(res.status).toBe(200);
    const again = AuthSessionResponseSchema.parse(await res.json());
    expect(again).toMatchObject({ created: false, user: { id: first.user.id } });
    expect(t.turnstileCalls).toBe(1);
    expect(await ledgerCount(env.DB, first.user.id)).toBe(1);
  });

  it('signs in to the fixture wallet account', async () => {
    const t = authEnv();
    // The fixture wallet 0x1111… has no key; sign in a fresh wallet linked to the fixture user.
    const account = newAccount();
    await env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES ('01K7000000000000000000004Z', ?1, 'wallet', ?2, 1)",
    )
      .bind(FIXTURE_IDS.user, account.address.toLowerCase())
      .run();
    const res = await call(t.env, 'POST', '/auth/siwe/verify', await siweBody(t.env, account));
    expect(res.status).toBe(200);
    expect(AuthSessionResponseSchema.parse(await res.json()).user).toMatchObject({
      id: FIXTURE_IDS.user,
      handle: 'ewe_one',
    });
  });

  it('returns a Bearer token instead of a cookie when asked', async () => {
    const t = authEnv();
    const res = await call(
      t.env,
      'POST',
      '/auth/siwe/verify',
      await siweBody(t.env, newAccount(), { turnstileToken: 'tok', transport: 'bearer' }),
    );
    const body = AuthSessionResponseSchema.parse(await res.json());
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionSetCookie(res)).toBeNull();
  });

  it('records a pending referral for a valid ref code', async () => {
    const t = authEnv();
    const res = await call(
      t.env,
      'POST',
      '/auth/siwe/verify',
      await siweBody(t.env, newAccount(), { turnstileToken: 'tok', ref: 'REFUSER2' }),
    );
    const { user } = AuthSessionResponseSchema.parse(await res.json());
    const row = await env.DB.prepare(
      'SELECT referrer_user_id, status FROM referrals WHERE referee_user_id = ?1',
    )
      .bind(user.id)
      .first();
    expect(row).toEqual({ referrer_user_id: FIXTURE_IDS.otherUser, status: 'pending' });
  });

  it('ignores an unknown ref code', async () => {
    const t = authEnv();
    const res = await call(
      t.env,
      'POST',
      '/auth/siwe/verify',
      await siweBody(t.env, newAccount(), { turnstileToken: 'tok', ref: 'NOSUCHREF' }),
    );
    expect(res.status).toBe(200);
  });

  describe('Turnstile on sign-up (spec "Anti-abuse")', () => {
    it('refuses a new account without a Turnstile token', async () => {
      const t = authEnv();
      const account = newAccount();
      const res = await call(t.env, 'POST', '/auth/siwe/verify', await siweBody(t.env, account));
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('turnstile_failed');
      expect(await identityOwner(account.address)).toBeNull();
    });

    it('refuses a new account when Turnstile rejects the token', async () => {
      const t = authEnv({ turnstile: false });
      const account = newAccount();
      const res = await call(
        t.env,
        'POST',
        '/auth/siwe/verify',
        await siweBody(t.env, account, { turnstileToken: 'bad' }),
      );
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('turnstile_failed');
      expect(await identityOwner(account.address)).toBeNull();
    });
  });

  describe('replay and nonce checks', () => {
    it('SIWE replay: the same signed message is refused the second time', async () => {
      const t = authEnv();
      const body = await siweBody(t.env, newAccount(), { turnstileToken: 'tok' });
      expect((await call(t.env, 'POST', '/auth/siwe/verify', body)).status).toBe(200);
      const replay = await call(t.env, 'POST', '/auth/siwe/verify', body);
      expect(replay.status).toBe(401);
      expect(await errorCode(replay)).toBe('invalid_nonce');
    });

    it('refuses a nonce the server never issued', async () => {
      const t = authEnv();
      const account = newAccount();
      const message = siweMessage(account.address, 'a'.repeat(32));
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message,
        signature: await account.signMessage({ message }),
      });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('invalid_nonce');
    });

    it('refuses an expired nonce', async () => {
      const t = authEnv();
      const account = newAccount();
      const n = await nonce(t.env);
      await env.KV.put(
        nonceKvKey(await nonceHash(n)),
        JSON.stringify({ expiresAt: Date.now() - 1 }),
      );
      const message = siweMessage(account.address, n);
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message,
        signature: await account.signMessage({ message }),
      });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('invalid_nonce');
    });

    it('burns the nonce even when the signature is wrong', async () => {
      const t = authEnv();
      const account = newAccount();
      const message = siweMessage(account.address, await nonce(t.env));
      const forged = await newAccount().signMessage({ message });
      const bad = await call(t.env, 'POST', '/auth/siwe/verify', { message, signature: forged });
      expect(bad.status).toBe(401);
      expect(await errorCode(bad)).toBe('invalid_signature');
      const good = await call(t.env, 'POST', '/auth/siwe/verify', {
        message,
        signature: await account.signMessage({ message }),
        turnstileToken: 'tok',
      });
      expect(await errorCode(good)).toBe('invalid_nonce');
    });
  });

  describe('message checks (nothing is consumed)', () => {
    const cases: [string, (n: string, a: Address) => string][] = [
      ['wrong domain', (n, a) => siweMessage(a, n, { domain: 'evil.test' })],
      ['wrong URI origin', (n, a) => siweMessage(a, n, { uri: 'https://evil.test/' })],
      ['wrong chain', (n, a) => siweMessage(a, n, { chainId: CHAIN_ID === 8453 ? 1 : 8453 })],
      [
        'expired message',
        (n, a) => siweMessage(a, n, { expirationTime: new Date(Date.now() - 1000) }),
      ],
      ['not yet valid', (n, a) => siweMessage(a, n, { notBefore: new Date(Date.now() + 60_000) })],
    ];
    it.each(cases)('%s → 401 invalid_signature', async (_label, build) => {
      const t = authEnv();
      const account = newAccount();
      const n = await nonce(t.env);
      const message = build(n, account.address);
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message,
        signature: await account.signMessage({ message }),
        turnstileToken: 'tok',
      });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('invalid_signature');
      // The nonce is still unused, so the correct message signs in.
      const ok = siweMessage(account.address, n);
      const retry = await call(t.env, 'POST', '/auth/siwe/verify', {
        message: ok,
        signature: await account.signMessage({ message: ok }),
        turnstileToken: 'tok',
      });
      expect(retry.status).toBe(200);
    });

    it('rejects a malformed message', async () => {
      const t = authEnv();
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message: 'hello',
        signature: '0x1234',
      });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('invalid_signature');
    });

    it('validates the body with the P2.4 schema', async () => {
      const t = authEnv();
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message: 'x',
        signature: 'nothex',
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    });

    it('answers 503 when APP_ORIGIN is not configured', async () => {
      const t = authEnv({ vars: { APP_ORIGIN: undefined } });
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message: siweMessage(newAccount().address, 'b'.repeat(32)),
        signature: '0x12',
      });
      expect(res.status).toBe(503);
      expect(await errorCode(res)).toBe('unavailable');
    });
  });

  describe('smart wallets', () => {
    const wallet = '0x5a11e7000000000000000000000000000000c0de' as Address;
    const factory = '0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a' as Address;

    it('ERC-6492: an undeployed Coinbase Smart Wallet signs in through the universal validator', async () => {
      const inner: Hex = `0x${'ab'.repeat(260)}`;
      const signature = serializeErc6492Signature({
        address: factory,
        data: '0xdeadbeef',
        signature: inner,
      });
      const rpc = mockRpc((data) => data.includes(signature.slice(2).toLowerCase()));
      const t = authEnv({ rpc });
      const message = siweMessage(wallet, await nonce(t.env));
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message,
        signature,
        turnstileToken: 'tok',
      });
      expect(res.status).toBe(200);
      const body = AuthSessionResponseSchema.parse(await res.json());
      expect(body.created).toBe(true);
      expect(await identityOwner(wallet)).toBe(body.user.id);
      // The validator call carried the wallet address and the wrapped signature.
      expect(rpc.calls.some((d) => d.includes(wallet.slice(2)))).toBe(true);
    });

    it('ERC-1271: a deployed smart wallet signs in', async () => {
      const deployed = '0x5a11e7000000000000000000000000000000beef' as Address;
      const signature = `0x${'cd'.repeat(97)}`;
      const rpc = mockRpc(
        (data) => data.includes(signature.slice(2)) && data.includes(deployed.slice(2)),
      );
      const t = authEnv({ rpc });
      const message = siweMessage(deployed, await nonce(t.env));
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message,
        signature,
        turnstileToken: 'tok',
      });
      expect(res.status).toBe(200);
    });

    it('refuses a smart-wallet signature the chain rejects', async () => {
      const t = authEnv({ rpc: mockRpc(() => false) });
      const message = siweMessage(wallet, await nonce(t.env));
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message,
        signature: `0x${'ef'.repeat(97)}`,
        turnstileToken: 'tok',
      });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('invalid_signature');
    });

    it('answers 503 when the RPC is down for a smart-wallet signature', async () => {
      const t = authEnv({ rpc: mockRpc(() => true, { fail: true }) });
      const message = siweMessage(wallet, await nonce(t.env));
      const res = await call(t.env, 'POST', '/auth/siwe/verify', {
        message,
        signature: `0x${'ef'.repeat(97)}`,
        turnstileToken: 'tok',
      });
      expect(res.status).toBe(503);
      expect(await errorCode(res)).toBe('unavailable');
    });

    it('EOA signatures verify even with the RPC down', async () => {
      const t = authEnv({ rpc: mockRpc(() => false, { fail: true }) });
      const res = await call(
        t.env,
        'POST',
        '/auth/siwe/verify',
        await siweBody(t.env, newAccount(), { turnstileToken: 'tok' }),
      );
      expect(res.status).toBe(200);
    });
  });
});
