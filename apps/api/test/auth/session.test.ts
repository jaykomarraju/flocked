// Sessions and the session middleware (wave-3 "Session middleware contract"): hashed IDs, cookie and
// Bearer transport, expiry, account status, logout.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { sessionMiddleware } from '../../src/auth/session.js';
import type { Env } from '../../src/env.js';
import { optionalUser, type AppEnv } from '../../src/lib/auth-context.js';
import { FIXTURE_IDS, realSession, seedFixture, withFixedClock } from '../helpers/index.js';
import { authEnv, call, errorCode, sessionSetCookie } from './fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

/** An app that echoes what the middleware set. */
function echoApp() {
  const app = new Hono<AppEnv>();
  app.use('*', sessionMiddleware);
  app.get('/whoami', optionalUser, (c) =>
    c.json({ user: c.get('user') ?? null, session: c.get('session') ?? null }),
  );
  return app;
}

async function whoami(e: Env, headers: Record<string, string>) {
  const res = await echoApp().request('https://flocked.test/whoami', { headers }, e);
  return { res, body: await res.json<{ user: unknown; session: unknown }>() };
}

describe('session middleware', () => {
  it('sets user and session from a cookie', async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.user, 'cookie');
    const { body } = await whoami(t.env, s.headers);
    expect(body).toEqual({
      user: {
        id: FIXTURE_IDS.user,
        status: 'active',
        role: 'user',
        personId: null,
        kycStatus: null,
      },
      session: { idHash: s.idHash, kind: 'cookie' },
    });
  });

  it('sets user and session from a Bearer token', async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.admin, 'bearer');
    const { body } = await whoami(t.env, s.headers);
    expect(body).toMatchObject({
      user: { id: FIXTURE_IDS.admin, role: 'admin' },
      session: { idHash: s.idHash, kind: 'bearer' },
    });
  });

  it('a Bearer header wins over the cookie and never falls back to it', async () => {
    const t = authEnv();
    const cookie = await realSession(t.env, FIXTURE_IDS.user, 'cookie');
    const { body } = await whoami(t.env, {
      ...cookie.headers,
      Authorization: `Bearer ${'x'.repeat(43)}`,
    });
    expect(body).toEqual({ user: null, session: null });
  });

  it('ignores unknown and malformed tokens', async () => {
    const t = authEnv();
    const cases: Record<string, string>[] = [
      { Authorization: `Bearer ${'A'.repeat(43)}` },
      { Authorization: 'Bearer short' },
      { Authorization: 'Basic abc' },
      { Cookie: 'flocked_session=nope' },
    ];
    for (const headers of cases) {
      expect((await whoami(t.env, headers)).body).toEqual({ user: null, session: null });
    }
  });

  it('an expired session does not authenticate, and its cookie is cleared', async () => {
    const t = authEnv();
    const s = await realSession(
      withFixedClock(t.env, Date.now() - 31 * 24 * 3600 * 1000),
      FIXTURE_IDS.user,
    );
    const { res, body } = await whoami(t.env, s.headers);
    expect(body.user).toBeNull();
    expect(sessionSetCookie(res)).toMatch(/Max-Age=0/);
  });

  it('suspended accounts keep their session (routes decide); merged and deleted ones do not', async () => {
    const t = authEnv();
    const ids = [
      '01K7000000000000000000S001',
      '01K7000000000000000000S002',
      '01K7000000000000000000S003',
    ];
    await env.DB.batch(
      [
        ['suspended', null],
        ['merged', FIXTURE_IDS.user],
        ['deleted', null],
      ].map(([status, mergedInto], i) =>
        env.DB.prepare(
          'INSERT INTO users (id, status, merged_into, ref_code, created_at) VALUES (?1, ?2, ?3, ?4, 1)',
        ).bind(ids[i], status, mergedInto, `REFS${i}XYZ`),
      ),
    );
    const results = [];
    for (const id of ids) {
      results.push((await whoami(t.env, (await realSession(t.env, id)).headers)).body.user);
    }
    expect(results).toEqual([expect.objectContaining({ status: 'suspended' }), null, null]);
  });
});

describe('session cookies', () => {
  it('staging and production use a Secure __Host- cookie', async () => {
    const t = authEnv({ vars: { ENVIRONMENT: 'production' } });
    const s = await realSession(t.env, FIXTURE_IDS.user, 'cookie');
    expect(s.headers.Cookie).toMatch(/^__Host-flocked_session=/);
    const { body } = await whoami(t.env, s.headers);
    expect(body.user).not.toBeNull();
    // The plain name is not read in production.
    const plain = { Cookie: s.headers.Cookie?.replace('__Host-', '') ?? '' };
    expect((await whoami(t.env, plain)).body.user).toBeNull();
  });

  it('logout deletes the session row and clears the cookie', async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.user, 'cookie');
    const res = await call(t.env, 'POST', '/auth/logout', undefined, s.headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sessionSetCookie(res)).toMatch(/Max-Age=0/);
    expect(
      await env.DB.prepare('SELECT 1 FROM sessions WHERE id_hash = ?1').bind(s.idHash).first(),
    ).toBeNull();
    const after = await call(t.env, 'GET', '/me', undefined, s.headers);
    expect(after.status).toBe(401);
  });

  it('logout without a session is 401', async () => {
    const t = authEnv();
    const res = await call(t.env, 'POST', '/auth/logout');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
  });
});
