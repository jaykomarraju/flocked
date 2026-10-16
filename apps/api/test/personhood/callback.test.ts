// Coinbase sign-in: POST /me/personhood and GET /me/personhood/callback (spec "Identity and
// personhood" › Personhood), through the real app and session middleware, against a fake Coinbase
// that checks PKCE. ID-3: the callback attributes only to the OAuth state's user (a callback with
// another user's session is refused), and a state is single-use.
import { env } from 'cloudflare:test';
import { MeResponseSchema, PersonhoodCallbackResponseSchema } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { realSession, seedFixture } from '../helpers/index.js';
import { call, errorCode } from '../auth/fixtures.js';
import { callback, newUser, person, personhoodEnv, start } from './fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

let seq = 0;
/** A fresh account with a real cookie session. */
async function account(t = personhoodEnv()) {
  const id = `01K70000000000000000PC${String(++seq).padStart(4, '0')}`;
  await newUser(id);
  return { id, headers: (await realSession(t.env, id)).headers };
}

async function userRow(id: string) {
  return env.DB.prepare(
    'SELECT person_id, kyc_status, person_verified_at, coinbase_country, coinbase_region FROM users WHERE id = ?1',
  )
    .bind(id)
    .first<{
      person_id: string | null;
      kyc_status: string | null;
      person_verified_at: number | null;
      coinbase_country: string | null;
      coinbase_region: string | null;
    }>();
}

async function outcome(res: Response) {
  expect(res.status).toBe(200);
  return PersonhoodCallbackResponseSchema.parse(await res.json());
}

describe('POST /me/personhood', () => {
  it('returns a Coinbase authorize URL with PKCE S256, the scopes, the redirect URI and a state', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const { url, state } = await start(t.env, a.headers);
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://login.coinbase.com/oauth2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: t.coinbase.clientId,
      redirect_uri: 'https://flocked.test/api/v1/me/personhood/callback',
      scope: 'wallet:user:read identity:user:address:read',
      code_challenge_method: 'S256',
    });
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A second start gets a different state and challenge.
    const again = new URL((await start(t.env, a.headers)).url);
    expect(again.searchParams.get('state')).not.toBe(state);
    expect(again.searchParams.get('code_challenge')).not.toBe(u.searchParams.get('code_challenge'));
  });

  it('needs a session', async () => {
    const t = personhoodEnv();
    const res = await call(t.env, 'POST', '/me/personhood');
    expect(res.status).toBe(401);
  });

  it('answers 503 unavailable when PERSON_ID_KEY or the Coinbase client is not configured', async () => {
    for (const vars of [
      { PERSON_ID_KEY: '' },
      { PERSON_ID_KEY: '0x1234' },
      { COINBASE_CLIENT_ID: '' },
    ]) {
      const t = personhoodEnv(vars);
      const a = await account(t);
      const res = await call(t.env, 'POST', '/me/personhood', undefined, a.headers);
      expect(res.status).toBe(503);
      expect(await errorCode(res)).toBe('unavailable');
    }
  });
});

describe('GET /me/personhood/callback', () => {
  it('verifies: stores the person ID, country, region and kyc_status, and GET /me shows it', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const { url, state } = await start(t.env, a.headers);
    const code = t.coinbase.approve(url, person(1, 'US', 'NJ'));
    const out = await outcome(await callback(t.env, { state, code }));
    expect(out).toMatchObject({ status: 'verified', country: 'US' });
    expect(t.coinbase.calls).toEqual([
      'POST /oauth2/token',
      'GET /v2/user',
      'GET /v2/user/personal-details',
    ]);

    const row = await userRow(a.id);
    expect(row).toMatchObject({
      kyc_status: 'verified',
      coinbase_country: 'US',
      coinbase_region: 'NJ',
    });
    expect(row?.person_id).toMatch(/^0x[0-9a-f]{64}$/);
    const identity = await env.DB.prepare(
      "SELECT external_id, verified_at FROM identities WHERE user_id = ?1 AND provider = 'coinbase'",
    )
      .bind(a.id)
      .first<{ external_id: string; verified_at: number }>();
    expect(identity?.external_id).toBe(row?.person_id);
    expect(t.notify.messages.map((m) => m.payload)).toContainEqual(
      expect.objectContaining({ kind: 'identity_linked' }),
    );

    const me = MeResponseSchema.parse(
      await (await call(t.env, 'GET', '/me', undefined, a.headers)).json(),
    );
    expect(me.verification).toEqual({
      personVerified: true,
      verifiedAt: row?.person_verified_at,
      country: 'US',
    });
    expect(me.identities).toContainEqual(
      expect.objectContaining({ provider: 'coinbase', externalId: null }),
    );
    expect(me.stakes.reasons).not.toContain('not_verified');
  });

  it("ID-3 login CSRF: a callback carrying another user's session is refused and binds nothing", async () => {
    const t = personhoodEnv();
    const starter = await account(t);
    const victim = await account(t);
    const { url, state } = await start(t.env, starter.headers);
    const code = t.coinbase.approve(url, person(2));
    // The victim's browser delivers the starter's callback, with the victim's session cookie.
    expect(await outcome(await callback(t.env, { state, code }, victim.headers))).toEqual({
      status: 'failed',
      reason: 'invalid_state',
    });
    const none = { person_id: null, kyc_status: null };
    expect(await userRow(starter.id)).toMatchObject(none);
    expect(await userRow(victim.id)).toMatchObject(none);
    expect(t.coinbase.calls).toEqual([]);
    // The state is spent: it can't be replayed without the session either.
    expect(await outcome(await callback(t.env, { state, code }))).toEqual({
      status: 'failed',
      reason: 'invalid_state',
    });
    expect(await userRow(starter.id)).toMatchObject(none);
    expect(t.coinbase.calls).toEqual([]);
  });

  it("ID-3: a callback with no session, or the state's user's own, attributes to the state's user", async () => {
    const t = personhoodEnv();
    // No session: the sign-in finished in another browser (the mini app's external browser).
    const a = await account(t);
    const one = await start(t.env, a.headers);
    const out = await outcome(
      await callback(t.env, { state: one.state, code: t.coinbase.approve(one.url, person(11)) }),
    );
    expect(out.status).toBe('verified');
    expect((await userRow(a.id))?.kyc_status).toBe('verified');
    // The state's user's own session.
    const b = await account(t);
    const two = await start(t.env, b.headers);
    const code = t.coinbase.approve(two.url, person(12));
    expect(
      (await outcome(await callback(t.env, { state: two.state, code }, b.headers))).status,
    ).toBe('verified');
    expect((await userRow(b.id))?.kyc_status).toBe('verified');
  });

  it('ID-3 replay: a used state fails and changes nothing', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const { url, state } = await start(t.env, a.headers);
    const code = t.coinbase.approve(url, person(3));
    expect((await outcome(await callback(t.env, { state, code }))).status).toBe('verified');
    const before = await userRow(a.id);
    const code2 = t.coinbase.approve(url, person(4));
    expect(await outcome(await callback(t.env, { state, code: code2 }))).toEqual({
      status: 'failed',
      reason: 'invalid_state',
    });
    expect(await userRow(a.id)).toEqual(before);
    // Coinbase was not called for the replay.
    expect(t.coinbase.calls.filter((c) => c === 'POST /oauth2/token')).toHaveLength(1);
  });

  it('an unknown state, and an expired one, fail before Coinbase is called', async () => {
    const t = personhoodEnv();
    expect(await outcome(await callback(t.env, { state: 'x'.repeat(43), code: 'c' }))).toEqual({
      status: 'failed',
      reason: 'invalid_state',
    });
    // Started 11 minutes ago (the state lives 10).
    const past = personhoodEnv({
      ENVIRONMENT: 'local',
      FLOCKED_TEST_CLOCK: String(Date.now() - 11 * 60_000),
    });
    const a = await account(past);
    const { url, state } = await start(past.env, a.headers);
    const code = t.coinbase.approve(url, person(5));
    expect(await outcome(await callback(t.env, { state, code }))).toEqual({
      status: 'failed',
      reason: 'invalid_state',
    });
    expect(t.coinbase.calls).toEqual([]);
  });

  it('a declined sign-in spends the state', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const { url, state } = await start(t.env, a.headers);
    expect(await outcome(await callback(t.env, { state, error: 'access_denied' }))).toEqual({
      status: 'failed',
      reason: 'denied',
    });
    const code = t.coinbase.approve(url, person(6));
    expect((await outcome(await callback(t.env, { state, code }))).status).toBe('failed');
    expect((await userRow(a.id))?.person_id).toBeNull();
  });

  it('missing personal details mean not verified: the person ID is bound, kyc_status is unverified', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const { url, state } = await start(t.env, a.headers);
    const code = t.coinbase.approve(url, { ...person(7), personal: null });
    expect(await outcome(await callback(t.env, { state, code }))).toEqual({
      status: 'failed',
      reason: 'not_id_verified',
    });
    const row = await userRow(a.id);
    expect(row).toMatchObject({
      kyc_status: 'unverified',
      person_verified_at: null,
      coinbase_country: null,
      coinbase_region: null,
    });
    expect(row?.person_id).toMatch(/^0x[0-9a-f]{64}$/);
    const me = MeResponseSchema.parse(
      await (await call(t.env, 'GET', '/me', undefined, a.headers)).json(),
    );
    expect(me.verification).toEqual({ personVerified: false, verifiedAt: null, country: null });
    expect(me.stakes.reasons).toContain('not_verified');
  });

  it('a Coinbase failure reports coinbase_error and never downgrades a verification', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const first = await start(t.env, a.headers);
    const p = person(8, 'GB', 'LND');
    await callback(t.env, { state: first.state, code: t.coinbase.approve(first.url, p) });
    const before = await userRow(a.id);
    expect(before?.kyc_status).toBe('verified');

    for (const failStep of [
      { step: 'token', status: 400 },
      { step: 'user', status: 500 },
      { step: 'personal', status: 502 },
    ] as const) {
      t.coinbase.failStep = failStep;
      const s = await start(t.env, a.headers);
      expect(
        await outcome(
          await callback(t.env, { state: s.state, code: t.coinbase.approve(s.url, p) }),
        ),
      ).toEqual({ status: 'failed', reason: 'coinbase_error' });
    }
    expect(await userRow(a.id)).toEqual(before);
  });

  it('a wrong PKCE verifier is refused by Coinbase (the challenge is bound to the state)', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const one = await start(t.env, a.headers);
    const two = await start(t.env, a.headers);
    // A code issued against the first flow's challenge, redeemed with the second flow's state.
    const code = t.coinbase.approve(one.url, person(9));
    expect(await outcome(await callback(t.env, { state: two.state, code }))).toEqual({
      status: 'failed',
      reason: 'coinbase_error',
    });
  });

  it('without Accept: application/json it redirects to Settings with the outcome', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const { url, state } = await start(t.env, a.headers);
    const code = t.coinbase.approve(url, person(10));
    const res = await call(t.env, 'GET', `/me/personhood/callback?state=${state}&code=${code}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://flocked.test/settings?personhood=verified');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bad = await call(t.env, 'GET', `/me/personhood/callback?state=${state}&code=${code}`);
    expect(bad.headers.get('location')).toBe(
      'https://flocked.test/settings?personhood=failed&reason=invalid_state',
    );
  });

  it('a callback without a state is a 400', async () => {
    const t = personhoodEnv();
    const res = await call(t.env, 'GET', '/me/personhood/callback?code=abc');
    expect(res.status).toBe(400);
  });
});

// W7-F1 R12 (decision B7): suspended accounts sign in read-only, and verifying is a write.
describe('suspended accounts cannot verify', () => {
  const suspend = (id: string) =>
    env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(id).run();

  it('POST /me/personhood refuses account_suspended', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    await suspend(a.id);
    const res = await call(t.env, 'POST', '/me/personhood', undefined, a.headers);
    expect([res.status, await errorCode(res)]).toEqual([403, 'account_suspended']);
  });

  it('a callback for an account suspended since it started binds nothing and starts no merge', async () => {
    const t = personhoodEnv();
    const p = person(301);
    // Another account holds the person: an active caller would get a pending merge.
    const holder = await account(t);
    const first = await start(t.env, holder.headers);
    const verified = await callback(t.env, {
      state: first.state,
      code: t.coinbase.approve(first.url, p),
    });
    expect((await outcome(verified)).status).toBe('verified');

    for (const who of [p, person(302)]) {
      const a = await account(t);
      const { url, state } = await start(t.env, a.headers);
      await suspend(a.id);
      const out = await outcome(
        await callback(t.env, { state, code: t.coinbase.approve(url, who) }),
      );
      expect(out).toEqual({ status: 'failed', reason: 'account_suspended' });
      expect((await userRow(a.id))?.person_id).toBeNull();
      const merges = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM merges WHERE kept_user_id = ?1 OR losing_user_id = ?1',
      )
        .bind(a.id)
        .first<{ n: number }>();
      expect(merges?.n).toBe(0);
    }
  });
});
