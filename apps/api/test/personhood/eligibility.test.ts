// Stakes eligibility (`stakesEligibility`, wave-5 pinned interface; spec "Identity and personhood" ›
// Personhood › Country, "Compliance and responsible play" › Geo-fencing, Age and terms): the
// Coinbase attestations on a linked wallet, the country match, `geo.stakes.allow` for the verified
// country and the request location, proxy signals, ToS and age, exclusion, suspension and the kill
// switch; and GET /me reporting it.
import { env } from 'cloudflare:test';
import { API_BASE_PATH, MeResponseSchema } from '@flocked/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { stakesEligibility } from '../../src/personhood/eligibility.js';
import { parseGeoAllow } from '../../src/personhood/config-store.js';
import { realSession, seedFixture } from '../helpers/index.js';
import { ORIGIN, TOS } from '../auth/fixtures.js';
import { linkWallet, newUser, personhoodEnv, type PersonhoodTest } from './fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

/** A request from `country`/`regionCode` with optional extra `cf` fields. */
function from(country?: string, regionCode?: string, extra: Record<string, unknown> = {}): Request {
  const cf = { ...(country ? { country } : {}), ...(regionCode ? { regionCode } : {}), ...extra };
  return new Request(`${ORIGIN}/`, { cf });
}

async function setConfig(allow: string[] | null, enabled: boolean | null): Promise<void> {
  const db = env.DB;
  await db.batch([
    db.prepare('DELETE FROM config'),
    ...(allow
      ? [
          db
            .prepare(
              "INSERT INTO config (key, value_json, updated_at) VALUES ('geo.stakes.allow', ?1, 0)",
            )
            .bind(JSON.stringify(allow)),
        ]
      : []),
    ...(enabled !== null
      ? [
          db
            .prepare(
              "INSERT INTO config (key, value_json, updated_at) VALUES ('mode.stakes.enabled', ?1, 0)",
            )
            .bind(JSON.stringify(enabled)),
        ]
      : []),
  ]);
}

let seq = 0;
/**
 * A user who passes everything but what the test changes: verified with Coinbase in `country`,
 * ToS and age current, one linked wallet attested for `attested` (null: no attestations).
 */
async function player(
  t: PersonhoodTest,
  opts: { country?: string; attested?: string | null; verified?: boolean } = {},
): Promise<{ id: string; wallet: Address }> {
  const id = `01K70000000000000000PE${String(++seq).padStart(4, '0')}`;
  const country = opts.country ?? 'US';
  await newUser(id);
  await env.DB.prepare(
    'UPDATE users SET tos_version = ?2, tos_accepted_at = ?7, age_attested_at = ?7, person_id = ?3, ' +
      'kyc_status = ?4, person_verified_at = ?7, coinbase_country = ?5, coinbase_region = ?6 WHERE id = ?1',
  )
    .bind(
      id,
      TOS,
      `0x${String(seq).padStart(64, '0')}`,
      opts.verified === false ? 'unverified' : 'verified',
      country,
      'NJ',
      Date.now(),
    )
    .run();
  const wallet = privateKeyToAccount(generatePrivateKey()).address;
  await linkWallet(id, wallet);
  const attested = opts.attested === undefined ? country : opts.attested;
  if (attested) t.chain.verify(wallet, attested);
  return { id, wallet };
}

const fresh = { attestationMaxAgeMs: 0 };

describe('stakesEligibility', () => {
  it('eligible: verified, attested country matches, country and request on the allow list, flag on', async () => {
    await setConfig(['US'], true);
    const t = personhoodEnv();
    const p = await player(t);
    expect(await stakesEligibility(t.env, p, from('US', 'NJ'))).toEqual({
      eligible: true,
      reasons: [],
    });
  });

  it('a country mismatch makes the user ineligible', async () => {
    await setConfig(['US', 'CA'], true);
    const t = personhoodEnv();
    const p = await player(t, { country: 'US', attested: 'CA' });
    expect(await stakesEligibility(t.env, p, from('US', 'NJ'))).toEqual({
      eligible: false,
      reasons: ['country_mismatch'],
    });
  });

  it('missing personal details (kyc_status unverified) mean not verified; attestations are not read', async () => {
    await setConfig(['US'], true);
    const t = personhoodEnv();
    const p = await player(t, { verified: false });
    t.chain.fail = true; // a lookup would fail; none happens
    expect(await stakesEligibility(t.env, p, from('US', 'NJ'), fresh)).toEqual({
      eligible: false,
      reasons: ['not_verified'],
    });
  });

  it('no attestation, a revoked one, a foreign attester or an RPC failure: country_unverified', async () => {
    await setConfig(['US'], true);
    const t = personhoodEnv();
    const none = await player(t, { attested: null });
    expect((await stakesEligibility(t.env, none, from('US'), fresh)).reasons).toEqual([
      'country_unverified',
    ]);

    const revoked = await player(t);
    const uid = t.chain.attest(revoked.wallet, 'country', { country: 'US' });
    expect((await stakesEligibility(t.env, revoked, from('US'), fresh)).eligible).toBe(true);
    t.chain.revoke(uid);
    expect((await stakesEligibility(t.env, revoked, from('US'), fresh)).reasons).toEqual([
      'country_unverified',
    ]);

    const foreign = await player(t, { attested: null });
    t.chain.attest(foreign.wallet, 'account', {
      attester: '0x000000000000000000000000000000000000bEEF',
    });
    t.chain.attest(foreign.wallet, 'country', {
      country: 'US',
      attester: '0x000000000000000000000000000000000000bEEF',
    });
    expect((await stakesEligibility(t.env, foreign, from('US'), fresh)).reasons).toEqual([
      'country_unverified',
    ]);

    const expired = await player(t, { attested: null });
    t.chain.attest(expired.wallet, 'account');
    t.chain.attest(expired.wallet, 'country', { country: 'US', expirationTime: 1000n });
    expect((await stakesEligibility(t.env, expired, from('US'), fresh)).reasons).toEqual([
      'country_unverified',
    ]);

    const down = await player(t);
    t.chain.fail = true;
    expect((await stakesEligibility(t.env, down, from('US'), fresh)).reasons).toEqual([
      'country_unverified',
    ]);
  });

  it('caches attestation reads per wallet for GET /me; a ticket (maxAge 0) re-reads them', async () => {
    await setConfig(['US'], true);
    const t = personhoodEnv();
    const p = await player(t);
    expect((await stakesEligibility(t.env, p, from('US'))).eligible).toBe(true);
    const row = await env.DB.prepare(
      "SELECT data_json FROM identities WHERE user_id = ?1 AND provider = 'wallet'",
    )
      .bind(p.id)
      .first<{ data_json: string }>();
    expect(JSON.parse(row?.data_json ?? '{}')).toMatchObject({
      attestations: {
        country: 'US',
        verifiedAccount: expect.stringMatching(/^0x/) as unknown,
        verifiedCountry: expect.stringMatching(/^0x/) as unknown,
      },
    });
    t.chain.fail = true;
    expect((await stakesEligibility(t.env, p, from('US'))).eligible).toBe(true);
    expect((await stakesEligibility(t.env, p, from('US'), fresh)).reasons).toEqual([
      'country_unverified',
    ]);
  });

  it('any one attested wallet with the matching country is enough', async () => {
    await setConfig(['US'], true);
    const t = personhoodEnv();
    const p = await player(t, { attested: 'CA' });
    const second = privateKeyToAccount(generatePrivateKey()).address;
    await linkWallet(p.id, second);
    t.chain.verify(second, 'US');
    expect((await stakesEligibility(t.env, p, from('US'), fresh)).eligible).toBe(true);
  });

  it('geo: the verified country and the request location must both be allowed', async () => {
    const t = personhoodEnv();
    const p = await player(t, { country: 'US' });
    await setConfig(['GB'], true);
    expect((await stakesEligibility(t.env, p, from('GB'))).reasons).toEqual(['geo_blocked']);
    expect((await stakesEligibility(t.env, p, from('US', 'NJ'))).reasons).toEqual(['geo_blocked']);
    await setConfig(['US-NJ'], true);
    expect((await stakesEligibility(t.env, p, from('US', 'NJ'))).eligible).toBe(true);
    expect((await stakesEligibility(t.env, p, from('US', 'NY'))).reasons).toEqual(['geo_blocked']);
    expect((await stakesEligibility(t.env, p, from('US'))).reasons).toEqual(['geo_blocked']);
    // Unknown location (no cf, or XX) is not allowed.
    expect((await stakesEligibility(t.env, p, new Request(ORIGIN))).reasons).toEqual([
      'geo_blocked',
    ]);
    expect((await stakesEligibility(t.env, p, from('XX'))).reasons).toEqual(['geo_blocked']);
    // Default: an empty allow list means Stakes is unavailable everywhere.
    await setConfig(null, true);
    expect((await stakesEligibility(t.env, p, from('US', 'NJ'))).reasons).toEqual(['geo_blocked']);
  });

  it('proxy signals: a Tor exit or a low bot score', async () => {
    await setConfig(['US'], true);
    const t = personhoodEnv();
    const p = await player(t);
    expect((await stakesEligibility(t.env, p, from('T1'))).reasons).toEqual([
      'geo_blocked',
      'proxy_detected',
    ]);
    expect(
      (await stakesEligibility(t.env, p, from('US', 'NJ', { botManagement: { score: 5 } })))
        .reasons,
    ).toEqual(['proxy_detected']);
    expect(
      (await stakesEligibility(t.env, p, from('US', 'NJ', { botManagement: { score: 90 } })))
        .eligible,
    ).toBe(true);
  });

  it('ToS, age, self-exclusion, suspension and the kill switch', async () => {
    await setConfig(['US'], null);
    const t = personhoodEnv();
    const p = await player(t);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET tos_version = 'old', age_attested_at = NULL, status = 'suspended' WHERE id = ?1",
      ).bind(p.id),
      env.DB.prepare(
        'INSERT INTO limits (user_id, self_exclusion_started_at, self_exclusion_until) VALUES (?1, ?2, ?3)',
      ).bind(p.id, now, now + 86_400_000),
    ]);
    expect((await stakesEligibility(t.env, p, from('US'))).reasons).toEqual([
      'age_unattested',
      'tos_not_accepted',
      'self_excluded',
      'suspended',
      'stakes_disabled',
    ]);
  });
});

describe('geo.stakes.allow parsing', () => {
  it('keeps countries and subdivisions, drops anything else', () => {
    expect(parseGeoAllow('["GB","US-NJ","us","USA","US-","", 7]')).toEqual([
      { country: 'GB', region: null },
      { country: 'US', region: 'NJ' },
    ]);
    expect(parseGeoAllow('{"US":true}')).toEqual([]);
    expect(parseGeoAllow('not json')).toEqual([]);
    expect(parseGeoAllow(null)).toEqual([]);
  });
});

describe('GET /me', () => {
  it('reports Stakes eligibility with reasons, from the request location', async () => {
    await setConfig(['US'], true);
    const t = personhoodEnv();
    const p = await player(t, { country: 'US', attested: 'CA' });
    const { headers } = await realSession(t.env, p.id);
    const get = async (cf: Record<string, unknown>) => {
      const req = new Request(`${ORIGIN}${API_BASE_PATH}/me`, { headers, cf });
      const res = await app.request(req, undefined, t.env);
      expect(res.status).toBe(200);
      return MeResponseSchema.parse(await res.json());
    };
    expect((await get({ country: 'US', regionCode: 'NJ' })).stakes).toEqual({
      eligible: false,
      reasons: ['country_mismatch'],
    });
    t.chain.verify(p.wallet, 'US');
    // GET /me caches attestations for 10 minutes: clear the cache to see the new one.
    await env.DB.prepare("UPDATE identities SET data_json = '{}' WHERE user_id = ?1")
      .bind(p.id)
      .run();
    expect((await get({ country: 'US', regionCode: 'NJ' })).stakes).toEqual({
      eligible: true,
      reasons: [],
    });
    expect((await get({ country: 'FR' })).stakes).toEqual({
      eligible: false,
      reasons: ['geo_blocked'],
    });
  });
});
