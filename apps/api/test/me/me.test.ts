// GET /me, PATCH /me, POST /me/tos (spec "API"), validated against the P2.4 schemas, through real
// sessions and the session middleware.
import { env } from 'cloudflare:test';
import { AcceptTosResponseSchema, MeResponseSchema } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IDS, realSession, seedFixture, withFixedClock } from '../helpers/index.js';
import { TOS, authEnv, call, errorCode } from '../auth/fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

/** A bare new account (as sign-up leaves it): no handle, no ToS. */
async function newUser(id: string): Promise<void> {
  await env.DB.prepare('INSERT INTO users (id, ref_code, created_at) VALUES (?1, ?2, ?3)')
    .bind(id, `REF${id.slice(-6)}`, Date.now())
    .run();
}

async function me(headers: Record<string, string>, e = authEnv().env) {
  const res = await call(e, 'GET', '/me', undefined, headers);
  return { res, body: res.status === 200 ? MeResponseSchema.parse(await res.json()) : null };
}

describe('GET /me', () => {
  it('returns the profile, balances, limits, flags, ToS, verification and Stakes eligibility', async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.user);
    const { res, body } = await me(s.headers, t.env);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      user: {
        id: FIXTURE_IDS.user,
        handle: 'ewe_one',
        role: 'user',
        status: 'active',
        refCode: 'REFUSER1',
      },
      prefs: { showCardAmounts: false, showStakesNet: false, creatorPayoutWallet: null },
      notificationPrefs: [],
      identities: [{ provider: 'wallet', externalId: `0x${'11'.repeat(20)}` }],
      merges: [],
      balances: { global: '500', rooms: [{ roomId: FIXTURE_IDS.room, balance: '500' }] },
      limits: { dailyStakeCap: null, excluded: false },
      flags: { needsHandle: false },
      tos: { currentVersion: TOS, acceptedVersion: '2026-10-01' },
      verification: { personVerified: false, verifiedAt: null, country: null },
      // Stakes eligibility is `not_verified` until Coinbase verification lands (W5-B).
      stakes: { eligible: false, reasons: ['not_verified'] },
    });
  });

  it('a new account has no handle yet and every unmet Stakes requirement listed', async () => {
    const id = '01K70000000000000000NEW001';
    await newUser(id);
    const t = authEnv();
    const { body } = await me((await realSession(t.env, id)).headers, t.env);
    expect(body?.user.handle).toBeNull();
    expect(body?.flags).toEqual({ needsHandle: true });
    expect(body?.balances).toEqual({ global: '0', rooms: [] });
    expect(body?.stakes.reasons).toEqual(['not_verified', 'age_unattested', 'tos_not_accepted']);
  });

  it('reports a self-exclusion and a suspension', async () => {
    const id = '01K70000000000000000NEW002';
    await newUser(id);
    const t = authEnv();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(id),
      env.DB.prepare(
        'INSERT INTO limits (user_id, self_exclusion_started_at, self_exclusion_until) VALUES (?1, ?2, ?3)',
      ).bind(id, now, now + 86_400_000),
    ]);
    const { body } = await me((await realSession(t.env, id)).headers, t.env);
    expect(body?.user.status).toBe('suspended');
    expect(body?.limits.excluded).toBe(true);
    expect(body?.stakes.reasons).toEqual(
      expect.arrayContaining(['self_excluded', 'suspended', 'not_verified']),
    );
  });

  it('401 without a session', async () => {
    const res = await call(authEnv().env, 'GET', '/me');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
  });

  it('503 when TOS_VERSION is not configured', async () => {
    const t = authEnv({ vars: { TOS_VERSION: undefined } });
    const res = await call(
      t.env,
      'GET',
      '/me',
      undefined,
      (await realSession(t.env, FIXTURE_IDS.user)).headers,
    );
    expect(res.status).toBe(503);
  });
});

describe('PATCH /me', () => {
  it('sets the handle and display name', async () => {
    const id = '01K70000000000000000NEW003';
    await newUser(id);
    const t = authEnv();
    const s = await realSession(t.env, id);
    const res = await call(
      t.env,
      'PATCH',
      '/me',
      { handle: 'lamb-3', displayName: '  Lamb́ Three ' },
      s.headers,
    );
    expect(res.status).toBe(200);
    const body = MeResponseSchema.parse(await res.json());
    expect(body.user).toMatchObject({
      handle: 'lamb-3',
      displayName: 'Lamb́ Three'.normalize('NFC'),
    });
    expect(body.flags.needsHandle).toBe(false);

    const cleared = MeResponseSchema.parse(
      await (await call(t.env, 'PATCH', '/me', { displayName: null }, s.headers)).json(),
    );
    expect(cleared.user.displayName).toBeNull();
  });

  it('409 handle_taken for a handle in use (case-insensitively unique)', async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.otherUser);
    const res = await call(t.env, 'PATCH', '/me', { handle: 'ewe_one' }, s.headers);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('handle_taken');
    // Keeping one's own handle is fine.
    expect((await call(t.env, 'PATCH', '/me', { handle: 'ewe_two' }, s.headers)).status).toBe(200);
  });

  it('rejects handles outside ^[a-z0-9_-]{3,20}$, bad display names and empty updates', async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.otherUser);
    for (const body of [
      { handle: 'Ewe' },
      { handle: 'ab' },
      { handle: 'a'.repeat(21) },
      { handle: 'ewe one' },
      { displayName: '   ' },
      { displayName: 'bad\u0000name' },
      { displayName: 'x'.repeat(41) },
      {},
      { role: 'admin' },
    ]) {
      const res = await call(t.env, 'PATCH', '/me', body, s.headers);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('updates card prefs and notification prefs (upsert)', async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.otherUser);
    const wallet = '0x00000000000000000000000000000000000000aa';
    await call(
      t.env,
      'PATCH',
      '/me',
      {
        prefs: { showCardAmounts: true, creatorPayoutWallet: wallet },
        notificationPrefs: [{ channel: 'email', event: 'outcome', enabled: true }],
      },
      s.headers,
    );
    const res = await call(
      t.env,
      'PATCH',
      '/me',
      {
        prefs: { showStakesNet: true },
        notificationPrefs: [{ channel: 'email', event: 'outcome', enabled: false }],
      },
      s.headers,
    );
    const body = MeResponseSchema.parse(await res.json());
    expect(body.prefs).toEqual({
      showCardAmounts: true,
      showStakesNet: true,
      creatorPayoutWallet: wallet,
    });
    expect(body.notificationPrefs).toEqual([
      { channel: 'email', event: 'outcome', enabled: false },
    ]);
  });

  it('401 without a session', async () => {
    expect((await call(authEnv().env, 'PATCH', '/me', { displayName: 'x' })).status).toBe(401);
  });
});

describe('POST /me/tos', () => {
  it('accepts the current version and attests age', async () => {
    const id = '01K70000000000000000NEW004';
    await newUser(id);
    const t = authEnv();
    const fixed = withFixedClock(t.env);
    const s = await realSession(fixed, id);
    const res = await call(
      fixed,
      'POST',
      '/me/tos',
      { tosVersion: TOS, ageAttested: true },
      s.headers,
    );
    expect(res.status).toBe(200);
    const body = AcceptTosResponseSchema.parse(await res.json());
    expect(body.tos).toEqual({
      currentVersion: TOS,
      acceptedVersion: TOS,
      acceptedAt: Number(fixed.FLOCKED_TEST_CLOCK),
      ageAttestedAt: Number(fixed.FLOCKED_TEST_CLOCK),
    });
    const { body: view } = await me(s.headers, fixed);
    expect(view?.stakes.reasons).toEqual(['not_verified']);
  });

  it('409 for a stale version; 400 without the age attestation', async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.otherUser);
    const stale = await call(
      t.env,
      'POST',
      '/me/tos',
      { tosVersion: '2025-01-01', ageAttested: true },
      s.headers,
    );
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('conflict');
    const noAge = await call(
      t.env,
      'POST',
      '/me/tos',
      { tosVersion: TOS, ageAttested: false },
      s.headers,
    );
    expect(noAge.status).toBe(400);
  });
});

describe('the rest of the me module', () => {
  it('still answers 501 for endpoints owned by later sessions', async () => {
    const t = authEnv();
    const s = await realSession(t.env, FIXTURE_IDS.user);
    const res = await call(t.env, 'POST', '/me/email', { email: 'a@flocked.test' }, s.headers);
    expect(res.status).toBe(501);
    expect(await errorCode(res)).toBe('not_implemented');
  });
});
