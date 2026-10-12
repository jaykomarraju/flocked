// ID-1 (linking): POST /me/identities/link and POST /me/email + /me/email/verify link an identity
// only with proof of control (SIWE, Farcaster Quick Auth, an email code); an identity another
// account holds creates a pending merge and moves nothing; unverified rows never block (W3-Z);
// Farcaster-verified wallets are offered; every new link sends a security notice.
import { env } from 'cloudflare:test';
import {
  AddEmailResponseSchema,
  LinkIdentityResponseSchema,
  MeResponseSchema,
  newUlid,
} from '@flocked/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { refreshFarcasterOffers, withFarcasterWallets } from '../../src/identity/offers.js';
import { seedFixture } from '../helpers/index.js';
import { call, errorCode, siweBody } from '../auth/fixtures.js';
import {
  account,
  balance,
  farcasterProof,
  identitiesOf,
  identityEnv,
  link,
  pendingMerge,
  userRow,
  walletProof,
  DAY,
} from './fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

describe('POST /me/identities/link', () => {
  it('links a new wallet with SIWE and sends identity_linked', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const other = privateKeyToAccount(generatePrivateKey());
    const res = await link(t, a, await walletProof(t.env, other));
    expect(res.status).toBe(200);
    const body = LinkIdentityResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      status: 'linked',
      identity: { provider: 'wallet', externalId: other.address.toLowerCase() },
    });
    expect((await identitiesOf(a.id)).map((i) => i.external_id)).toContain(
      other.address.toLowerCase(),
    );
    expect(t.notify.messages.map((m) => [m.event, m.userId, m.payload])).toEqual([
      [
        'security_notice',
        a.id,
        { noticeId: expect.any(String) as string, kind: 'identity_linked' },
      ],
    ]);
  });

  it('refuses a bad proof: a SIWE signature by another key, a Quick Auth token for another app', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const claimed = privateKeyToAccount(generatePrivateKey());
    const signer = privateKeyToAccount(generatePrivateKey());
    const { message } = await siweBody(t.env, claimed);
    const forged = await link(t, a, {
      provider: 'wallet',
      message,
      signature: await signer.signMessage({ message }),
    });
    expect(forged.status).toBe(401);
    expect(await errorCode(forged)).toBe('invalid_signature');
    const foreign = await link(t, a, {
      provider: 'farcaster',
      token: await t.fc.mint(4242, { aud: 'elsewhere.test' }),
    });
    expect(foreign.status).toBe(401);
    expect(await errorCode(foreign)).toBe('invalid_token');
    expect(await identitiesOf(a.id)).toHaveLength(2);
    expect(t.notify.messages).toHaveLength(0);
  });

  it('linking what the account already has is a no-op: linked, no second notice', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const res = await link(t, a, await walletProof(t.env, a.wallet));
    expect(await res.json()).toMatchObject({ status: 'linked' });
    expect(t.notify.messages).toHaveLength(0);
  });

  it('an identity verified on another account creates a pending merge (kept = older) and moves nothing', async () => {
    const t = await identityEnv();
    const older = await account(t, { createdAt: Date.now() - 60 * DAY, points: 700 });
    const newer = await account(t, { points: 300 });
    const merge = await pendingMerge(t, newer, await walletProof(t.env, older.wallet));
    expect(merge).toMatchObject({
      status: 'pending',
      keptUserId: older.id,
      losingUserId: newer.id,
      provider: 'wallet',
      confirmedAt: null,
    });
    expect(merge.expiresAt - merge.createdAt).toBe(7 * DAY);
    // Nothing moved: identities, balances, statuses.
    expect(await identitiesOf(older.id)).toHaveLength(2);
    expect(await identitiesOf(newer.id)).toHaveLength(2);
    expect([await balance(older.id), await balance(newer.id)]).toEqual([700, 300]);
    expect((await userRow(newer.id))?.status).toBe('active');
    // The holder of the identity is told.
    expect(t.notify.messages.map((m) => [m.userId, m.payload])).toEqual([
      [older.id, { noticeId: expect.any(String) as string, kind: 'merge_pending' }],
    ]);
    // Linking again (another identity of the same account) reuses the open merge.
    const again = await pendingMerge(t, newer, await farcasterProof(t, older.fid));
    expect(again.id).toBe(merge.id);
    expect(t.notify.messages).toHaveLength(1);
    // Both sides see it in GET /me.
    for (const who of [older, newer]) {
      const me = MeResponseSchema.parse(
        await (await call(t.env, 'GET', '/me', undefined, who.headers)).json(),
      );
      expect(me.merges.map((m) => m.id)).toEqual([merge.id]);
    }
  });

  it('two accounts verified as different people cannot even start a merge', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const b = await account(t);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET person_id = ?2, kyc_status = 'verified' WHERE id = ?1").bind(
        a.id,
        `0x${'a1'.repeat(32)}`,
      ),
      env.DB.prepare("UPDATE users SET person_id = ?2, kyc_status = 'verified' WHERE id = ?1").bind(
        b.id,
        `0x${'b2'.repeat(32)}`,
      ),
    ]);
    const res = await link(t, a, await walletProof(t.env, b.wallet));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('merge_blocked');
    expect(
      await env.DB.prepare('SELECT 1 FROM merges WHERE kept_user_id IN (?1, ?2)')
        .bind(a.id, b.id)
        .first(),
    ).toBeNull();
  });

  // W3-Z carry-over: an unverified row (an offer) belongs to nobody.
  it('an unverified row on another account never blocks: the prover links it and the offer goes', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const holder = await account(t);
    const w = privateKeyToAccount(generatePrivateKey());
    await env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'wallet', ?3, NULL)",
    )
      .bind(newUlid(Date.now()), holder.id, w.address.toLowerCase())
      .run();
    const res = await link(t, a, await walletProof(t.env, w));
    expect(await res.json()).toMatchObject({ status: 'linked' });
    expect((await identitiesOf(holder.id)).map((i) => i.external_id)).not.toContain(
      w.address.toLowerCase(),
    );
    expect(
      await env.DB.prepare('SELECT 1 FROM merges WHERE losing_user_id = ?1 OR kept_user_id = ?1')
        .bind(a.id)
        .first(),
    ).toBeNull();
  });

  it('an offered (unverified) row on the account itself becomes verified in place', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const w = privateKeyToAccount(generatePrivateKey());
    const id = newUlid(Date.now());
    await env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'wallet', ?3, NULL)",
    )
      .bind(id, a.id, w.address.toLowerCase())
      .run();
    const body = LinkIdentityResponseSchema.parse(
      await (await link(t, a, await walletProof(t.env, w))).json(),
    );
    expect(body).toMatchObject({ status: 'linked', identity: { id } });
    expect(body.status === 'linked' && body.identity.verifiedAt).toBeGreaterThan(0);
  });

  it('a suspended account cannot link', async () => {
    const t = await identityEnv();
    const a = await account(t);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(a.id).run();
    const res = await link(
      t,
      a,
      await walletProof(t.env, privateKeyToAccount(generatePrivateKey())),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('account_suspended');
  });
});

describe('Farcaster-verified wallets are offered for linking', () => {
  it('linking Farcaster offers its verified wallets as unverified rows; GET /me lists them', async () => {
    const base = await identityEnv();
    const a = await account(base);
    const fid = 777_000 + Math.floor(Math.random() * 1000);
    const offeredKey = privateKeyToAccount(generatePrivateKey());
    const offered = offeredKey.address.toLowerCase();
    const second = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const taken = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const holder = await account(base);
    await env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'wallet', ?3, 1)",
    )
      .bind(newUlid(Date.now()), holder.id, taken)
      .run();
    const lookups: string[] = [];
    const t = {
      ...base,
      env: withFarcasterWallets(base.env, (f) => {
        lookups.push(f);
        return Promise.resolve([offered, second, taken]);
      }),
    };
    // The account links its Farcaster account afresh (drop the fixture's FID first).
    await env.DB.prepare("DELETE FROM identities WHERE user_id = ?1 AND provider = 'farcaster'")
      .bind(a.id)
      .run();
    const res = await link(t, a, await farcasterProof(t, fid));
    expect(await res.json()).toMatchObject({
      status: 'linked',
      identity: { provider: 'farcaster' },
    });
    expect(lookups).toEqual([String(fid)]);
    const me = MeResponseSchema.parse(
      await (await call(t.env, 'GET', '/me', undefined, a.headers)).json(),
    );
    expect(me.identities).toContainEqual(
      expect.objectContaining({ provider: 'wallet', externalId: offered, verifiedAt: null }),
    );
    // A wallet another account holds is not offered.
    expect(me.identities.map((i) => i.externalId)).not.toContain(taken);
    // GET /me refreshes at most once a day.
    expect(lookups).toHaveLength(1);
    // A dismissed offer is not offered again on the next refresh.
    const offer = me.identities.find((i) => i.externalId === second);
    const dismiss = await call(
      t.env,
      'DELETE',
      `/me/identities/${offer?.id}`,
      undefined,
      a.headers,
    );
    expect(dismiss.status).toBe(200);
    expect(await refreshFarcasterOffers(t.env, a.id, Date.now(), true)).toBe(0);
    expect(lookups).toHaveLength(2);
    expect((await identitiesOf(a.id)).map((i) => i.external_id)).not.toContain(second);
    // An offer never signs in to the account (findAccount): SIWE with that wallet creates a new
    // account, which takes the address, and the offer is released.
    const signIn = await call(t.env, 'POST', '/auth/siwe/verify', {
      ...(await siweBody(t.env, offeredKey)),
      turnstileToken: 'ok',
    });
    expect(await signIn.json()).toMatchObject({ created: true });
    expect((await identitiesOf(a.id)).map((i) => i.external_id)).not.toContain(offered);
  });
});

describe('POST /me/email + /me/email/verify', () => {
  it('sends a code to the address, and the code links it', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const email = `link${Date.now()}@flocked.test`;
    const sent = await call(t.env, 'POST', '/me/email', { email: email.toUpperCase() }, a.headers);
    expect(sent.status).toBe(200);
    expect(AddEmailResponseSchema.parse(await sent.json()).email).toBe(email);
    expect(t.email.sent.map((m) => m.to)).toEqual([email]);
    const wrong = await call(
      t.env,
      'POST',
      '/me/email/verify',
      { email, code: '00000000' },
      a.headers,
    );
    expect(await errorCode(wrong)).toBe('invalid_code');
    const ok = await call(
      t.env,
      'POST',
      '/me/email/verify',
      { email, code: t.email.codes[0] },
      a.headers,
    );
    expect(await ok.json()).toMatchObject({
      status: 'linked',
      identity: { provider: 'email', externalId: email },
    });
    // A verified email now signs in to the account.
    await call(t.env, 'POST', '/auth/email/start', { email });
    const signIn = await call(t.env, 'POST', '/auth/email/verify', {
      email,
      code: t.email.codes[1],
    });
    expect(await signIn.json()).toMatchObject({ user: { id: a.id }, created: false });
  });

  it('an email another account has verified creates a pending merge', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const b = await account(t, { createdAt: Date.now() - 90 * DAY });
    const email = `shared${Date.now()}@flocked.test`;
    await env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'email', ?3, 1)",
    )
      .bind(newUlid(Date.now()), b.id, email)
      .run();
    await call(t.env, 'POST', '/me/email', { email }, a.headers);
    const res = await call(
      t.env,
      'POST',
      '/me/email/verify',
      { email, code: t.email.codes[0] },
      a.headers,
    );
    expect(await res.json()).toMatchObject({
      status: 'merge_pending',
      merge: { keptUserId: b.id, losingUserId: a.id, provider: 'email' },
    });
  });
});
