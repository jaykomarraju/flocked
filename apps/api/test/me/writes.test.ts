// The /me write rules W7-B adds: `POST /me/tos` takes `ageAttested: 18 | 21` and refuses one below
// the age the request's location requires (W6-Z carry-over); `PATCH /me` refuses reserved handles
// (W3-Z); suspended accounts can't write (W3-Z), except private notification preferences; and
// `buildMe` reports the eligibility it is given (W5-Z: one place decides it).
import { env } from 'cloudflare:test';
import { API_BASE_PATH, MeResponseSchema, newUlid } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { buildMe } from '../../src/auth/profile.js';
import type { Env } from '../../src/env.js';
import { realSession, seedFixture } from '../helpers/index.js';
import { ORIGIN, TOS, authEnv, call, errorCode } from '../auth/fixtures.js';
import { newUser } from '../personhood/fixtures.js';
import { setStakesConfig } from '../stakes/helpers.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

async function user(): Promise<{ id: string; headers: Record<string, string>; env: Env }> {
  const id = newUlid(Date.now());
  await newUser(id, Date.now() - 86_400_000);
  const e = authEnv().env;
  return { id, headers: (await realSession(e, id)).headers, env: e };
}

async function tos(
  u: Awaited<ReturnType<typeof user>>,
  ageAttested: number,
  cf: Record<string, unknown>,
): Promise<Response> {
  const req = new Request(`${ORIGIN}${API_BASE_PATH}/me/tos`, {
    method: 'POST',
    headers: { ...u.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ tosVersion: TOS, ageAttested }),
    cf,
  });
  return app.request(req, undefined, u.env);
}

async function attestedMin(id: string) {
  return (
    await env.DB.prepare('SELECT age_attested_min FROM users WHERE id = ?1')
      .bind(id)
      .first<{ age_attested_min: number }>()
  )?.age_attested_min;
}

describe('POST /me/tos: ageAttested is 18 or 21', () => {
  it('refuses an attestation below the age the request requires; records the age attested', async () => {
    await setStakesConfig({ age21: ['US-NJ'] });
    const u = await user();
    const nj = { country: 'US', regionCode: 'NJ' };
    const low = await tos(u, 18, nj);
    expect(low.status).toBe(409);
    expect(await errorCode(low)).toBe('conflict');
    expect(
      await env.DB.prepare('SELECT tos_accepted_at FROM users WHERE id = ?1').bind(u.id).first(),
    ).toEqual({ tos_accepted_at: null });

    const ok = await tos(u, 21, nj);
    expect(ok.status).toBe(200);
    expect((await ok.json<{ tos: { ageRequired: number } }>()).tos.ageRequired).toBe(21);
    expect(await attestedMin(u.id)).toBe(21);

    // From an 18+ region an 18 is enough, and it never lowers the recorded 21.
    expect((await tos(u, 18, { country: 'US', regionCode: 'NY' })).status).toBe(200);
    expect(await attestedMin(u.id)).toBe(21);
  });

  it('a 21 where 18 is required is recorded as 21', async () => {
    await setStakesConfig({ age21: [] });
    const u = await user();
    expect((await tos(u, 21, { country: 'US', regionCode: 'NY' })).status).toBe(200);
    expect(await attestedMin(u.id)).toBe(21);
  });
});

describe('PATCH /me: reserved handles', () => {
  it('refuses a reserved handle, ignoring separators; ordinary ones pass', async () => {
    const u = await user();
    for (const handle of ['admin', 'ad_min', 'flocked', 'support-']) {
      const res = await call(u.env, 'PATCH', '/me', { handle }, u.headers);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: { code: 'handle_taken', message: 'That handle is reserved' },
      });
    }
    const ok = await call(
      u.env,
      'PATCH',
      '/me',
      { handle: `admiral_${u.id.slice(-4).toLowerCase()}` },
      u.headers,
    );
    expect(ok.status).toBe(200);
  });
});

describe('suspended accounts are read-only', () => {
  it('every write route W7-B owns refuses account_suspended; notification prefs stay editable', async () => {
    const u = await user();
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(u.id).run();
    const writes: [string, string, unknown][] = [
      ['PATCH', '/me', { handle: `ewe_${u.id.slice(-5).toLowerCase()}` }],
      ['PATCH', '/me', { displayName: 'Shaun' }],
      ['PATCH', '/me', { prefs: { showStakesNet: true } }],
      ['POST', '/me/tos', { tosVersion: TOS, ageAttested: 18 }],
      ['POST', '/me/email', { email: 'suspended@flocked.test' }],
      ['POST', '/me/email/verify', { email: 'suspended@flocked.test', code: '12345678' }],
      ['POST', '/me/identities/link', { provider: 'farcaster', token: 'x' }],
      ['DELETE', `/me/identities/${newUlid(Date.now())}`, undefined],
      ['POST', `/me/merges/${newUlid(Date.now())}/confirm`, { provider: 'farcaster', token: 'x' }],
      ['DELETE', '/me', undefined],
      ['POST', '/me/limits/exclusion-lift', undefined],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(u.env, method, path, body, u.headers);
      expect([method, path, res.status, await errorCode(res)]).toEqual([
        method,
        path,
        403,
        'account_suspended',
      ]);
    }
    // Reads still work, and so do private notification preferences.
    expect((await call(u.env, 'GET', '/me', undefined, u.headers)).status).toBe(200);
    const prefs = await call(
      u.env,
      'PATCH',
      '/me',
      { notificationPrefs: [{ channel: 'email', event: 'outcome', enabled: false }] },
      u.headers,
    );
    expect(prefs.status).toBe(200);
  });
});

describe('buildMe', () => {
  it('reports the Stakes eligibility it is given, verbatim', async () => {
    const u = await user();
    const stakes = { eligible: false, reasons: ['stakes_disabled' as const] };
    const view = MeResponseSchema.parse(await buildMe(u.env, u.id, 18, stakes));
    expect(view.stakes).toEqual(stakes);
    const yes = await buildMe(u.env, u.id, 18, { eligible: true, reasons: [] });
    expect(yes.stakes).toEqual({ eligible: true, reasons: [] });
  });
});
