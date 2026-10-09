// AuthDO: single-use nonces, email-code attempts and OAuth state (spec "Data model"; W5-B uses the
// OAuth state). Exercised directly over RPC.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  authDOFor,
  emailCodeKvKey,
  nonceKvKey,
  type AuthDO,
} from '../../src/do/auth-do.js';

let n = 0;
const fresh = (p: string) => `${p}${++n}`;

describe('consumeNonce', () => {
  it('unknown → ok once → used', async () => {
    const h = fresh('nonce');
    const stub = authDOFor(env, 'nonce', h);
    expect(await stub.consumeNonce(h)).toEqual({ ok: false, reason: 'unknown' });
    await env.KV.put(nonceKvKey(h), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
    expect(await stub.consumeNonce(h)).toEqual({ ok: true });
    expect(await stub.consumeNonce(h)).toEqual({ ok: false, reason: 'used' });
    expect(await env.KV.get(nonceKvKey(h))).toBeNull();
  });

  it('concurrent consumes: exactly one wins', async () => {
    const h = fresh('nonce');
    await env.KV.put(nonceKvKey(h), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
    const stub = authDOFor(env, 'nonce', h);
    const results = await Promise.all(Array.from({ length: 8 }, () => stub.consumeNonce(h)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('expired → expired, and burned', async () => {
    const h = fresh('nonce');
    await env.KV.put(nonceKvKey(h), JSON.stringify({ expiresAt: Date.now() - 1 }));
    const stub = authDOFor(env, 'nonce', h);
    expect(await stub.consumeNonce(h)).toEqual({ ok: false, reason: 'expired' });
    expect(await stub.consumeNonce(h)).toEqual({ ok: false, reason: 'used' });
  });

  it('the alarm forgets the subject after expiry', async () => {
    const h = fresh('nonce');
    await env.KV.put(nonceKvKey(h), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
    const stub = authDOFor(env, 'nonce', h);
    await stub.consumeNonce(h);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const keys = await runInDurableObject(stub, async (_i: AuthDO, s) => [
      ...(await s.storage.list()).keys(),
    ]);
    expect(keys).toEqual([]);
  });
});

describe('consumeEmailCode', () => {
  it(`counts ${EMAIL_CODE_MAX_ATTEMPTS} attempts per code and reports what is left`, async () => {
    const e = fresh('email');
    await env.KV.put(
      emailCodeKvKey(e),
      JSON.stringify({ id: 'c1', codeHash: 'right', expiresAt: Date.now() + 60_000 }),
    );
    const stub = authDOFor(env, 'email', e);
    const left = [];
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
      left.push(await stub.consumeEmailCode({ emailHash: e, codeHash: 'wrong' }));
    }
    expect(left.map((r) => (r.ok ? 'ok' : `${r.reason}:${r.attemptsLeft}`))).toEqual([
      'wrong_code:4',
      'wrong_code:3',
      'wrong_code:2',
      'wrong_code:1',
      'wrong_code:0',
    ]);
    expect(await stub.consumeEmailCode({ emailHash: e, codeHash: 'right' })).toEqual({
      ok: false,
      reason: 'too_many_attempts',
      attemptsLeft: 0,
    });
  });

  it('right code → ok, then used', async () => {
    const e = fresh('email');
    await env.KV.put(
      emailCodeKvKey(e),
      JSON.stringify({ id: 'c2', codeHash: 'right', expiresAt: Date.now() + 60_000 }),
    );
    const stub = authDOFor(env, 'email', e);
    expect(await stub.consumeEmailCode({ emailHash: e, codeHash: 'right' })).toEqual({ ok: true });
    expect(await stub.consumeEmailCode({ emailHash: e, codeHash: 'right' })).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
  });

  it('expired → expired', async () => {
    const e = fresh('email');
    await env.KV.put(
      emailCodeKvKey(e),
      JSON.stringify({ id: 'c3', codeHash: 'right', expiresAt: Date.now() - 1 }),
    );
    expect(
      await authDOFor(env, 'email', e).consumeEmailCode({ emailHash: e, codeHash: 'right' }),
    ).toMatchObject({ ok: false, reason: 'expired' });
  });
});

describe('OAuth state (bindOAuthState / consumeOAuthState)', () => {
  const binding = (stateHash: string, expiresAt = Date.now() + 60_000) => ({
    stateHash,
    userId: '01K70000000000000000000001',
    codeVerifier: 'verifier',
    expiresAt,
  });

  it('binds once and consumes once', async () => {
    const h = fresh('state');
    const stub = authDOFor(env, 'oauth', h);
    await stub.bindOAuthState(binding(h));
    // A second bind cannot redirect the state to another user.
    await stub.bindOAuthState({ ...binding(h), userId: '01K70000000000000000000003' });
    expect(await stub.consumeOAuthState(h)).toEqual({
      ok: true,
      userId: '01K70000000000000000000001',
      codeVerifier: 'verifier',
    });
    expect(await stub.consumeOAuthState(h)).toEqual({ ok: false, reason: 'used' });
  });

  it('unknown and expired states', async () => {
    const h = fresh('state');
    const stub = authDOFor(env, 'oauth', h);
    expect(await stub.consumeOAuthState(h)).toEqual({ ok: false, reason: 'unknown' });
    const h2 = fresh('state');
    const stub2 = authDOFor(env, 'oauth', h2);
    await stub2.bindOAuthState(binding(h2, Date.now() - 1));
    expect(await stub2.consumeOAuthState(h2)).toEqual({ ok: false, reason: 'expired' });
    expect(await stub2.consumeOAuthState('other')).toEqual({ ok: false, reason: 'used' });
  });
});
