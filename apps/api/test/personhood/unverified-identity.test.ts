// W3-Z carry-over (src/auth/accounts.ts): an unverified identity row (offered for linking, never
// proven) must not block the sign-up that proves control of that identity. Before the fix,
// findAccount ignored the row, createAccount hit the (provider, external_id) unique index, and
// sign-in answered 500.
import { env } from 'cloudflare:test';
import { AuthSessionResponseSchema, newUlid } from '@flocked/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IDS, seedFixture } from '../helpers/index.js';
import { authEnv, call, quickAuthSigner, siweBody } from '../auth/fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

async function addIdentity(
  userId: string,
  provider: 'wallet' | 'farcaster',
  externalId: string,
  verifiedAt: number | null,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(newUlid(Date.now()), userId, provider, externalId, verifiedAt)
    .run();
}

const owners = async (provider: string, externalId: string) =>
  (
    await env.DB.prepare(
      'SELECT user_id, verified_at IS NOT NULL AS verified FROM identities WHERE provider = ?1 AND external_id = ?2',
    )
      .bind(provider, externalId)
      .all<{ user_id: string; verified: number }>()
  ).results;

describe('an unverified identity row does not block sign-in', () => {
  it("SIWE: the wallet signs up its own account; the other account's unverified claim is released", async () => {
    const t = authEnv();
    const account = privateKeyToAccount(generatePrivateKey());
    const wallet = account.address.toLowerCase();
    await addIdentity(FIXTURE_IDS.otherUser, 'wallet', wallet, null);

    const res = await call(
      t.env,
      'POST',
      '/auth/siwe/verify',
      await siweBody(t.env, account, { turnstileToken: 'tok' }),
    );
    expect(res.status).toBe(200);
    const body = AuthSessionResponseSchema.parse(await res.json());
    expect(body.created).toBe(true);
    expect(body.user.id).not.toBe(FIXTURE_IDS.otherUser);
    expect(await owners('wallet', wallet)).toEqual([{ user_id: body.user.id, verified: 1 }]);
  });

  it('Farcaster: the same for an unverified FID row', async () => {
    const signer = await quickAuthSigner();
    const t = authEnv({ farcasterKeys: signer.keys });
    await addIdentity(FIXTURE_IDS.otherUser, 'farcaster', '424242', null);
    const res = await call(t.env, 'POST', '/auth/farcaster', {
      token: await signer.mint(424242),
      turnstileToken: 'tok',
    });
    expect(res.status).toBe(200);
    const body = AuthSessionResponseSchema.parse(await res.json());
    expect(body.created).toBe(true);
    expect(await owners('farcaster', '424242')).toEqual([{ user_id: body.user.id, verified: 1 }]);
  });

  it('a verified row still signs in to its own account and is never released', async () => {
    const signer = await quickAuthSigner();
    const t = authEnv({ farcasterKeys: signer.keys });
    await addIdentity(FIXTURE_IDS.otherUser, 'farcaster', '434343', Date.now());
    const res = await call(t.env, 'POST', '/auth/farcaster', { token: await signer.mint(434343) });
    expect(res.status).toBe(200);
    const body = AuthSessionResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ created: false, user: { id: FIXTURE_IDS.otherUser } });
    expect(await owners('farcaster', '434343')).toEqual([
      { user_id: FIXTURE_IDS.otherUser, verified: 1 },
    ]);
  });
});
