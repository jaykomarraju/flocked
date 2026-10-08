// Farcaster Quick Auth sign-in and the mini app's Bearer-token flow (ID-4: Bearer flow).
import { env } from 'cloudflare:test';
import { AuthSessionResponseSchema, MeResponseSchema } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashSessionToken } from '../../src/auth/session.js';
import { balanceOf, seedFixture } from '../helpers/index.js';
import {
  authEnv,
  call,
  errorCode,
  quickAuthSigner,
  sessionSetCookie,
  type QuickAuthSigner,
} from './fixtures.js';

let signer: QuickAuthSigner;

beforeAll(async () => {
  await seedFixture(env.DB);
  signer = await quickAuthSigner();
});

const fcEnv = () => authEnv({ farcasterKeys: signer.keys });
let nextFid = 100_000;

describe('POST /auth/farcaster', () => {
  it('ID-4 Bearer flow: Quick Auth token → Bearer session → /me → logout → 401', async () => {
    const t = fcEnv();
    const fid = nextFid++;
    const res = await call(t.env, 'POST', '/auth/farcaster', {
      token: await signer.mint(fid),
      turnstileToken: 'tok',
    });
    expect(res.status).toBe(200);
    const body = AuthSessionResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ created: true, user: { handle: null } });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionSetCookie(res)).toBeNull();

    // Only the hash is stored.
    const token = body.token as string;
    const row = await env.DB.prepare('SELECT id_hash, user_id FROM sessions WHERE user_id = ?1')
      .bind(body.user.id)
      .first<{ id_hash: string }>();
    expect(row?.id_hash).toBe(await hashSessionToken(token));
    expect(row?.id_hash).not.toContain(token);

    const bearer = { Authorization: `Bearer ${token}` };
    const me = await call(t.env, 'GET', '/me', undefined, bearer);
    expect(me.status).toBe(200);
    const view = MeResponseSchema.parse(await me.json());
    expect(view.user.id).toBe(body.user.id);
    expect(view.identities).toEqual([
      expect.objectContaining({ provider: 'farcaster', externalId: String(fid) }),
    ]);
    expect(view.balances.global).toBe('500');

    const out = await call(t.env, 'POST', '/auth/logout', undefined, bearer);
    expect(out.status).toBe(200);
    expect(
      await env.DB.prepare('SELECT 1 FROM sessions WHERE user_id = ?1').bind(body.user.id).first(),
    ).toBeNull();
    const after = await call(t.env, 'GET', '/me', undefined, bearer);
    expect(after.status).toBe(401);
    expect(await errorCode(after)).toBe('unauthorized');
  });

  it('signs in to the existing Farcaster account (no Turnstile, no second grant)', async () => {
    const t = fcEnv();
    const fid = nextFid++;
    const first = AuthSessionResponseSchema.parse(
      await (
        await call(t.env, 'POST', '/auth/farcaster', {
          token: await signer.mint(fid),
          turnstileToken: 'tok',
        })
      ).json(),
    );
    const again = await call(t.env, 'POST', '/auth/farcaster', { token: await signer.mint(fid) });
    expect(again.status).toBe(200);
    expect(AuthSessionResponseSchema.parse(await again.json())).toMatchObject({
      created: false,
      user: { id: first.user.id },
    });
    expect(t.turnstileCalls).toBe(1);
    expect(await balanceOf(env.DB, first.user.id)).toBe(500);
  });

  it('can carry the session in a cookie instead', async () => {
    const t = fcEnv();
    const res = await call(t.env, 'POST', '/auth/farcaster', {
      token: await signer.mint(nextFid++),
      turnstileToken: 'tok',
      transport: 'cookie',
    });
    expect(AuthSessionResponseSchema.parse(await res.json()).token).toBeNull();
    expect(sessionSetCookie(res)).toMatch(/HttpOnly/);
  });

  it('requires Turnstile to create an account', async () => {
    const t = fcEnv();
    const res = await call(t.env, 'POST', '/auth/farcaster', {
      token: await signer.mint(nextFid++),
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('turnstile_failed');
  });

  describe('rejects tokens not meant for this app', () => {
    const now = () => Math.floor(Date.now() / 1000);
    it.each([
      ['another audience', () => signer.mint(7, { aud: 'other.app' })],
      ['another issuer', () => signer.mint(7, { iss: 'https://evil.test' })],
      ['expired', () => signer.mint(7, { iatSec: now() - 7200, expSec: now() - 3600 })],
      ['a bad FID', () => signer.mint('0x07')],
      ['garbage', () => Promise.resolve('not.a.jwt')],
    ])('%s → 401 invalid_token', async (_label, token) => {
      const t = fcEnv();
      const res = await call(t.env, 'POST', '/auth/farcaster', {
        token: await token(),
        turnstileToken: 'tok',
      });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('invalid_token');
    });

    it('a token signed by a key outside the JWKS → 401 invalid_token', async () => {
      const other = await quickAuthSigner('test-key');
      const t = fcEnv();
      const res = await call(t.env, 'POST', '/auth/farcaster', {
        token: await other.mint(7),
        turnstileToken: 'tok',
      });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('invalid_token');
    });
  });

  it('answers 503 when the JWKS cannot be fetched', async () => {
    const t = authEnv({
      farcasterKeys: () => Promise.reject(new TypeError('fetch failed')),
    });
    const res = await call(t.env, 'POST', '/auth/farcaster', {
      token: await signer.mint(7),
      turnstileToken: 'tok',
    });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('unavailable');
  });
});
