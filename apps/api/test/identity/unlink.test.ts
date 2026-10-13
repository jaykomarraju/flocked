// ID-1 (unlinking): DELETE /me/identities/:id keeps a sign-in identity, never removes the bound
// coinbase identity (W5-Z carry-over), and never a wallet with Stakes entries in a round that isn't
// final or with unclaimed payouts (spec "Identity and personhood" › Identities).
import { env } from 'cloudflare:test';
import { UnlinkIdentityResponseSchema, newUlid } from '@flocked/shared';
import { getAddress } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedFixture } from '../helpers/index.js';
import { call, errorCode } from '../auth/fixtures.js';
import { account, identitiesOf, identityEnv, type Account, type IdentityTest } from './fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

async function unlink(t: IdentityTest, who: Account, identityId: string) {
  return call(t.env, 'DELETE', `/me/identities/${identityId}`, undefined, who.headers);
}

/** The account's verified identity of `provider`. */
async function idOf(userId: string, provider: string): Promise<string> {
  const row = (await identitiesOf(userId)).find(
    (i) => i.provider === provider && i.verified_at !== null,
  );
  if (!row) throw new Error(`no ${provider} identity`);
  return row.id;
}

let n = 0;

/** A Stakes entry from `wallet` (stored checksummed, as the indexer may) in a round whose Stakes mode has `status`. */
async function stakesEntry(userId: string, wallet: string, status: string): Promise<string> {
  const t = Date.now();
  const roundId = newUlid(t);
  n++;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rounds (id, kind, status, opens_at, closes_at) VALUES (?1, 'daily', 'closed', ?2, ?3)",
    ).bind(roundId, t - 2 * 86_400_000, t - 86_400_000 + n * 1000),
    env.DB.prepare(
      "INSERT INTO round_modes (round_id, mode, status, final_at) VALUES (?1, 'stakes', ?2, ?3)",
    ).bind(roundId, status, status === 'settled' ? t : null),
    env.DB.prepare(
      'INSERT INTO entries (id, round_id, mode, user_id, wallet, person_tag, stake, commitment, tx_hash, block_number, log_index, created_at) ' +
        "VALUES (?1, ?2, 'stakes', ?3, ?4, ?5, 5000000, ?6, ?7, 1, ?8, ?9)",
    ).bind(
      newUlid(t),
      roundId,
      userId,
      getAddress(wallet),
      `0x${'7e'.repeat(32)}`,
      `0x${'ab'.repeat(32)}`,
      `0x${n.toString(16).padStart(64, '0')}`,
      n,
      t,
    ),
  ]);
  return roundId;
}

describe('DELETE /me/identities/:id', () => {
  it('removes an identity while another sign-in identity remains, and answers the rest', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const res = await unlink(t, a, await idOf(a.id, 'farcaster'));
    expect(res.status).toBe(200);
    const body = UnlinkIdentityResponseSchema.parse(await res.json());
    expect(body.identities.map((i) => i.provider)).toEqual(['wallet']);
  });

  it('never the last sign-in identity: identity_required (an unverified offer does not count)', async () => {
    const t = await identityEnv();
    const a = await account(t);
    await unlink(t, a, await idOf(a.id, 'farcaster'));
    const offer = newUlid(Date.now());
    await env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'wallet', ?3, NULL)",
    )
      .bind(offer, a.id, `0x${'0f'.repeat(20)}`)
      .run();
    const last = await unlink(t, a, await idOf(a.id, 'wallet'));
    expect(last.status).toBe(409);
    expect(await errorCode(last)).toBe('identity_required');
    // The offer itself can always be dismissed.
    expect((await unlink(t, a, offer)).status).toBe(200);
    expect((await identitiesOf(a.id)).map((i) => i.provider)).toEqual(['wallet']);
  });

  it('two concurrent unlinks of the last two sign-in identities leave one', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const ids = [await idOf(a.id, 'wallet'), await idOf(a.id, 'farcaster')];
    const results = await Promise.all(ids.map((id) => unlink(t, a, id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await identitiesOf(a.id)).toHaveLength(1);
  });

  it('never the coinbase identity once a person ID is bound: identity_locked', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const id = newUlid(Date.now());
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET person_id = ?2, kyc_status = 'verified' WHERE id = ?1").bind(
        a.id,
        `0x${'c0'.repeat(32)}`,
      ),
      env.DB.prepare(
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'coinbase', ?3, 1)",
      ).bind(id, a.id, `0x${'c0'.repeat(32)}`),
    ]);
    const res = await unlink(t, a, id);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('identity_locked');
    expect((await identitiesOf(a.id)).map((i) => i.provider)).toContain('coinbase');
  });

  it('never a wallet with a Stakes entry in a round that is not final, or with unclaimed payouts', async () => {
    const t = await identityEnv();
    const a = await account(t);
    const wallet = a.wallet.address.toLowerCase();
    const walletId = await idOf(a.id, 'wallet');
    const roundId = await stakesEntry(a.id, wallet, 'settle_proposed');
    const open = await unlink(t, a, walletId);
    expect(open.status).toBe(409);
    expect(await errorCode(open)).toBe('identity_locked');

    // Final, with an unclaimed win: still locked.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE round_modes SET status = 'settled', final_at = 1 WHERE round_id = ?1 AND mode = 'stakes'",
      ).bind(roundId),
      env.DB.prepare(
        "INSERT INTO payouts (round_id, mode, user_id, wallet, kind, amount) VALUES (?1, 'stakes', ?2, ?3, 'win', 9000000)",
      ).bind(roundId, a.id, wallet),
    ]);
    expect(await errorCode(await unlink(t, a, walletId))).toBe('identity_locked');

    // Claimed: the wallet can go.
    await env.DB.prepare('UPDATE payouts SET claimed_at = 1 WHERE round_id = ?1')
      .bind(roundId)
      .run();
    expect((await unlink(t, a, walletId)).status).toBe(200);
  });

  it("another account's identity is not found; a suspended account cannot unlink", async () => {
    const t = await identityEnv();
    const a = await account(t);
    const b = await account(t);
    const theirs = await unlink(t, a, await idOf(b.id, 'farcaster'));
    expect(theirs.status).toBe(404);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(a.id).run();
    const suspended = await unlink(t, a, await idOf(a.id, 'farcaster'));
    expect(suspended.status).toBe(403);
    expect(await errorCode(suspended)).toBe('account_suspended');
  });
});
