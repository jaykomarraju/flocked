// Rate limits (spec "API" › Rate limits): the token-bucket math, RateLimitDO (state dropped once
// the bucket is full again), per-IP limits on the unauthenticated auth endpoints and per-user
// limits on writes.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMITS, ipAuthBucket } from '../../src/auth/rate-limit.js';
import { takeFromBucket, type RateLimitDO } from '../../src/do/rate-limit-do.js';
import { FIXTURE_IDS, realSession, seedFixture } from '../helpers/index.js';
import { authEnv, call, errorCode } from './fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

describe('takeFromBucket', () => {
  const bucket = { key: 'k', capacity: 10, periodMs: 60_000 };

  it('starts full and takes', () => {
    const r = takeFromBucket(undefined, bucket, 1, 1000);
    expect(r.decision).toEqual({ allowed: true, remaining: 9, retryAfterMs: 0 });
    expect(r.state).toEqual({ tokens: 9, at: 1000 });
    expect(r.fullAt).toBe(1000 + 6000);
  });

  it('refuses when empty and says when to retry; a refusal takes nothing', () => {
    const empty = { tokens: 0, at: 0 };
    const r = takeFromBucket(empty, bucket, 1, 0);
    expect(r.decision).toEqual({ allowed: false, remaining: 0, retryAfterMs: 6000 });
    expect(r.state.tokens).toBe(0);
  });

  it('refills continuously, capped at capacity', () => {
    expect(takeFromBucket({ tokens: 0, at: 0 }, bucket, 1, 6000).decision.allowed).toBe(true);
    expect(takeFromBucket({ tokens: 0, at: 0 }, bucket, 1, 5999).decision.allowed).toBe(false);
    expect(takeFromBucket({ tokens: 3, at: 0 }, bucket, 0, 10 * 60_000).state.tokens).toBe(10);
  });

  it('a cost above capacity is never allowed', () => {
    const r = takeFromBucket(undefined, bucket, 11, 0);
    expect(r.decision.allowed).toBe(false);
    expect(r.decision.retryAfterMs).toBe(60_000);
  });

  it('rejects malformed buckets', () => {
    expect(() => takeFromBucket(undefined, { ...bucket, capacity: 0 }, 1, 0)).toThrow(RangeError);
    expect(() => takeFromBucket(undefined, { ...bucket, periodMs: 0.5 }, 1, 0)).toThrow(RangeError);
    expect(() => takeFromBucket(undefined, bucket, -1, 0)).toThrow(RangeError);
  });
});

describe('RateLimitDO', () => {
  it('enforces the bucket and drops its state when the alarm fires', async () => {
    const bucket = { key: 'test:alarm', capacity: 2, periodMs: 60_000 };
    const stub = env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(bucket.key));
    expect((await stub.take(bucket, 1)).allowed).toBe(true);
    expect((await stub.take(bucket, 1)).allowed).toBe(true);
    const refused = await stub.take(bucket, 1);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(
      await runInDurableObject(stub, (_i: RateLimitDO, state) => state.storage.getAlarm()),
    ).not.toBeNull();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const keys = await runInDurableObject(stub, async (_i: RateLimitDO, state) => [
      ...(await state.storage.list()).keys(),
    ]);
    expect(keys).toEqual([]);
    expect((await stub.take(bucket, 1)).remaining).toBe(1);
  });
});

describe('per-IP limit on unauthenticated auth endpoints', () => {
  it(`allows ${RATE_LIMITS.authIp.capacity} per minute per IP, then 429 with Retry-After`, async () => {
    const t = authEnv();
    const ip = { 'CF-Connecting-IP': '203.0.113.9' };
    for (let i = 0; i < RATE_LIMITS.authIp.capacity; i++) {
      expect((await call(t.env, 'POST', '/auth/siwe/nonce', undefined, ip)).status).toBe(200);
    }
    // The bucket is shared across the auth endpoints.
    const res = await call(t.env, 'POST', '/auth/email/start', { email: 'x@flocked.test' }, ip);
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    // Another IP is unaffected.
    const other = { 'CF-Connecting-IP': '203.0.113.10' };
    expect((await call(t.env, 'POST', '/auth/siwe/nonce', undefined, other)).status).toBe(200);
  });

  it('keys the bucket by a hash of the IP, never the IP', async () => {
    const bucket = await ipAuthBucket('203.0.113.9');
    expect(bucket.key).toMatch(/^ip:0x[0-9a-f]{64}:auth$/);
    expect(bucket.key).not.toContain('203.0.113.9');
  });
});

describe('per-user write limit', () => {
  it(`PATCH /me allows ${RATE_LIMITS.writes.capacity} per minute, then 429`, async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.otherUser);
    for (let i = 0; i < RATE_LIMITS.writes.capacity; i++) {
      const res = await call(t.env, 'PATCH', '/me', { displayName: `Ewe ${i}` }, s.headers);
      expect(res.status).toBe(200);
    }
    const res = await call(
      t.env,
      'POST',
      '/me/tos',
      { tosVersion: '2026-10-01', ageAttested: true },
      s.headers,
    );
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('rate_limited');
  });
});
