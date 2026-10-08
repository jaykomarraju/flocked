// src/lib: logger redaction, clock, Turnstile, errors and validation, alerts, auth context.
import { env } from 'cloudflare:test';
import { ErrorEnvelopeSchema } from '@flocked/shared';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { raiseAlert } from '../src/lib/alert.js';
import {
  getUser,
  optionalUser,
  requireAdmin,
  requireUser,
  type AppEnv,
} from '../src/lib/auth-context.js';
import { now, nowSeconds } from '../src/lib/clock.js';
import { HttpError, NotImplementedError, isNotImplemented } from '../src/lib/errors.js';
import { REDACTED_FIELDS, formatLog, log, redact } from '../src/lib/log.js';
import { SITEVERIFY_URL, verifyTurnstile } from '../src/lib/turnstile.js';
import { validate } from '../src/lib/validate.js';
import { FIXED_NOW, fakeAdmin, fakeUser, withFixedClock, withSession } from './helpers/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('log redaction (sealed picks: nothing pick-revealing before the beacon)', () => {
  const secretish = {
    roundId: 'r1',
    optionIndex: 1,
    plaintext: 'AQID',
    nonce: 'n',
    nested: {
      entries: [
        { userId: 'u1', option_index: 0, stake: 10n },
        { userId: 'u2', deeper: { plaintext: 'x', nonce: 'y', keep: true } },
      ],
    },
  };

  it('drops optionIndex, option_index, plaintext and nonce at any depth by default', () => {
    const out = redact(secretish);
    const json = JSON.stringify(out);
    for (const field of REDACTED_FIELDS) expect(json).not.toContain(`"${field}"`);
    expect(out).toEqual({
      roundId: 'r1',
      nested: {
        entries: [
          { userId: 'u1', stake: '10' },
          { userId: 'u2', deeper: { keep: true } },
        ],
      },
    });
  });

  it('keeps them only with { afterBeacon: true }', () => {
    const out = redact(secretish, { afterBeacon: true }) as typeof secretish;
    expect(out.optionIndex).toBe(1);
    expect(out.plaintext).toBe('AQID');
    expect(out.nonce).toBe('n');
  });

  it('formats one JSON line; level and event cannot be overridden by data', () => {
    const line = formatLog('info', 'entry_accepted', {
      level: 'debug',
      event: 'x',
      optionIndex: 0,
      seq: 3,
    });
    expect(JSON.parse(line)).toEqual({ seq: 3, level: 'info', event: 'entry_accepted' });
  });

  it('handles cycles, errors, bytes and bigints', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redact({ a, err: new RangeError('boom'), ct: new Uint8Array(34), n: 2n ** 70n });
    expect(out).toEqual({
      a: { name: 'a', self: '[Circular]' },
      err: { name: 'RangeError', message: 'boom' },
      ct: '[34 bytes]',
      n: (2n ** 70n).toString(),
    });
  });

  it('log.* writes redacted JSON to the console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info('submit', { nonce: 'secret', userId: 'u' });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toBe('{"userId":"u","level":"info","event":"submit"}');
  });
});

describe('clock', () => {
  it('returns Date.now() without a test clock', () => {
    const before = Date.now();
    const t = now({ ENVIRONMENT: 'local' });
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it('honours FLOCKED_TEST_CLOCK in local', () => {
    const e = withFixedClock(env);
    expect(now(e)).toBe(FIXED_NOW);
    expect(nowSeconds(e)).toBe(Math.floor(FIXED_NOW / 1000));
    expect(now({ ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: '1' })).toBe(1);
  });

  it.each(['staging', 'production'] as const)('ignores FLOCKED_TEST_CLOCK in %s', (environment) => {
    const t = now({ ENVIRONMENT: environment, FLOCKED_TEST_CLOCK: '1000' });
    expect(t).not.toBe(1000);
    expect(Math.abs(t - Date.now())).toBeLessThan(5_000);
  });

  it('rejects a malformed test clock in local', () => {
    expect(() => now({ ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: '12.5' })).toThrow(RangeError);
    expect(() => now({ ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: '-1' })).toThrow(RangeError);
  });

  it('treats an empty test clock as unset', () => {
    expect(
      Math.abs(now({ ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: '' }) - Date.now()),
    ).toBeLessThan(5_000);
  });
});

describe('turnstile', () => {
  const ok = (body: unknown, status = 200) =>
    vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));

  it('posts the secret, token and remote IP to siteverify', async () => {
    const f = ok({ success: true, 'error-codes': [], hostname: 'flocked.app', action: 'signup' });
    const res = await verifyTurnstile(env, 'tok', {
      remoteIp: '203.0.113.7',
      fetch: f,
      expectedAction: 'signup',
    });
    expect(res).toEqual({
      success: true,
      errorCodes: [],
      hostname: 'flocked.app',
      action: 'signup',
    });
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe(SITEVERIFY_URL);
    const form = init?.body as FormData;
    expect(form.get('secret')).toBe('test-turnstile-secret');
    expect(form.get('response')).toBe('tok');
    expect(form.get('remoteip')).toBe('203.0.113.7');
  });

  it('reports a rejected token', async () => {
    const res = await verifyTurnstile(env, 'tok', {
      fetch: ok({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    });
    expect(res).toEqual({ success: false, errorCodes: ['timeout-or-duplicate'] });
  });

  it('fails an action mismatch', async () => {
    const res = await verifyTurnstile(env, 'tok', {
      fetch: ok({ success: true, action: 'entry' }),
      expectedAction: 'signup',
    });
    expect(res.success).toBe(false);
    expect(res.errorCodes).toContain('action-mismatch');
  });

  it('fails closed on HTTP and network errors, and without a secret', async () => {
    expect((await verifyTurnstile(env, 'tok', { fetch: ok({}, 500) })).errorCodes).toEqual([
      'http-500',
    ]);
    const boom = vi.fn<typeof fetch>(() => Promise.reject(new Error('down')));
    expect(await verifyTurnstile(env, 'tok', { fetch: boom })).toEqual({
      success: false,
      errorCodes: ['internal-error'],
    });
    const never = vi.fn<typeof fetch>();
    expect(await verifyTurnstile({}, 'tok', { fetch: never })).toEqual({
      success: false,
      errorCodes: ['missing-input-secret'],
    });
    expect(await verifyTurnstile(env, '', { fetch: never })).toEqual({
      success: false,
      errorCodes: ['invalid-input-response'],
    });
    expect(never).not.toHaveBeenCalled();
  });
});

describe('errors and validation', () => {
  const body = z.strictObject({ stake: z.string().regex(/^[0-9]+$/), note: z.string().optional() });
  const sub = new Hono<AppEnv>()
    .post(
      '/things/:id',
      validate('param', z.object({ id: z.string().length(3) })),
      validate('json', body),
      (c) => c.json({ id: c.req.valid('param').id, stake: c.req.valid('json').stake }),
    )
    .get('/search', validate('query', z.object({ limit: z.coerce.number().int().max(100) })), (c) =>
      c.json({ limit: c.req.valid('query').limit }),
    )
    .get('/teapot', () => {
      throw new HttpError('conflict', 'already there');
    })
    .get('/stub', () => {
      throw new NotImplementedError('GET /stub');
    })
    .get('/boom', () => {
      throw new Error('kaboom');
    });
  const app = withSession(sub);

  async function envelope(res: Response) {
    return ErrorEnvelopeSchema.parse(await res.json());
  }

  it('passes valid input through, parsed', async () => {
    const res = await app.request('/things/abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stake: '10' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'abc', stake: '10' });
    const q = await app.request('/search?limit=7');
    expect(await q.json()).toEqual({ limit: 7 });
  });

  it('answers 400 bad_request for invalid json, params and query', async () => {
    const bad = await app.request('/things/abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stake: 'ten', extra: 1 }),
    });
    expect(bad.status).toBe(400);
    const env1 = await envelope(bad);
    expect(env1.error.code).toBe('bad_request');
    expect(env1.error.message).toContain('stake');

    const param = await app.request('/things/abcd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"stake":"1"}',
    });
    expect(param.status).toBe(400);
    expect((await envelope(param)).error.message).toContain('Invalid param');

    const query = await app.request('/search?limit=1000');
    expect(query.status).toBe(400);
  });

  it('answers 400 bad_request for malformed JSON and a missing JSON content type', async () => {
    const malformed = await app.request('/things/abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"stake":',
    });
    expect(malformed.status).toBe(400);
    expect((await envelope(malformed)).error.code).toBe('bad_request');
    const noType = await app.request('/things/abc', { method: 'POST', body: '{"stake":"1"}' });
    expect(noType.status).toBe(400);
  });

  it('maps HttpError, NotImplementedError and unknown errors to the envelope', async () => {
    const conflict = await app.request('/teapot');
    expect(conflict.status).toBe(409);
    expect((await envelope(conflict)).error).toEqual({
      code: 'conflict',
      message: 'already there',
    });

    const stub = await app.request('/stub');
    expect(stub.status).toBe(501);
    expect((await envelope(stub)).error.code).toBe('not_implemented');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = await app.request('/boom');
    expect(boom.status).toBe(500);
    expect((await envelope(boom)).error).toEqual({ code: 'internal', message: 'Internal error' });
  });

  it('answers 404 not_found in the envelope', async () => {
    const res = await app.request('/nowhere');
    expect(res.status).toBe(404);
    expect((await envelope(res)).error.code).toBe('not_found');
  });

  it('recognises not-implemented errors by message (survives RPC)', () => {
    expect(isNotImplemented(new NotImplementedError('x'))).toBe(true);
    expect(isNotImplemented(new Error('not_implemented: RoundDO.init'))).toBe(true);
    expect(isNotImplemented(new Error('boom'))).toBe(false);
  });
});

describe('auth context', () => {
  const sub = new Hono<AppEnv>()
    .get('/mine', requireUser, (c) => c.json({ id: getUser(c).id }))
    .get('/maybe', optionalUser, (c) => c.json({ id: c.get('user')?.id ?? null }))
    .get('/admin', requireAdmin, (c) => c.json({ ok: true }));

  it('requireUser: 401 without a user, passes with one', async () => {
    const anon = await withSession(sub).request('/mine');
    expect(anon.status).toBe(401);
    expect(ErrorEnvelopeSchema.parse(await anon.json()).error.code).toBe('unauthorized');
    const signedIn = await withSession(sub, fakeUser()).request('/mine');
    expect(await signedIn.json()).toEqual({ id: fakeUser().id });
  });

  it('optionalUser: passes either way', async () => {
    expect(await (await withSession(sub).request('/maybe')).json()).toEqual({ id: null });
    expect(await (await withSession(sub, fakeUser()).request('/maybe')).json()).toEqual({
      id: fakeUser().id,
    });
  });

  it('requireAdmin: 401 anonymous, 403 for players, passes for admins', async () => {
    expect((await withSession(sub).request('/admin')).status).toBe(401);
    expect((await withSession(sub, fakeUser()).request('/admin')).status).toBe(403);
    expect((await withSession(sub, fakeAdmin()).request('/admin')).status).toBe(200);
  });
});

describe('alerts', () => {
  it('writes an error log line and an Analytics Engine data point', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writeDataPoint = vi.fn();
    raiseAlert({ ENVIRONMENT: 'local', ANALYTICS: { writeDataPoint } }, 'ALERT_COMMIT_LATE', {
      roundId: 'r1',
      nonce: 'never logged',
    });
    const line = JSON.parse(errSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({
      event: 'alert',
      level: 'error',
      code: 'ALERT_COMMIT_LATE',
      severity: 'page',
      roundId: 'r1',
    });
    expect(line).not.toHaveProperty('nonce');
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['ALERT_COMMIT_LATE'],
      blobs: ['ALERT_COMMIT_LATE', 'page', 'local', '{"roundId":"r1"}'],
      doubles: [1],
    });
  });

  it('never throws, even if Analytics Engine does', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const writeDataPoint = vi.fn(() => {
      throw new Error('AE down');
    });
    expect(() =>
      raiseAlert({ ENVIRONMENT: 'local', ANALYTICS: { writeDataPoint } }, 'ALERT_DO_ERROR'),
    ).not.toThrow();
  });

  it('works against the real ANALYTICS binding', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => raiseAlert(env, 'ALERT_INDEXER_LAG', { lagSec: 151 })).not.toThrow();
  });
});
