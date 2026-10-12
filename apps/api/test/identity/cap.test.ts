// W6-Z carry-over: the daily cap and the one-live-ticket rule are per person, through the real
// `/prepare` path. A merge carries the losing account's game-day tickets to the kept account, and a
// person who deletes an account and verifies a new one the same game day keeps the day's stakes
// (person_tombstones.user_id, migration 0015). Without the carry each would start from zero.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyVerification } from '../../src/personhood/verify.js';
import { realSession, seedFixture } from '../helpers/index.js';
import { TOS, call, siweBody } from '../auth/fixtures.js';
import { linkWallet, newUser } from '../personhood/fixtures.js';
import {
  T0,
  addWallet,
  clockAt,
  codeOf,
  player,
  prepare,
  round,
  setStakesConfig,
  stakesTest,
  ticketsOf,
  type StakesTest,
} from '../stakes/helpers.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

const DAY = 24 * 3600 * 1000;
const USDC = 1_000_000;

let t: StakesTest;
beforeEach(async () => {
  await setStakesConfig({});
  t = stakesTest();
});

/** A bare older account with ToS and 18+ current, a wallet of its own, and a bearer session. */
async function olderAccount() {
  const id = newUlid(T0 - 30 * DAY);
  await newUser(id, T0 - 30 * DAY);
  await env.DB.prepare(
    'UPDATE users SET tos_version = ?2, tos_accepted_at = ?3, age_attested_at = ?3 WHERE id = ?1',
  )
    .bind(id, TOS, T0 - 3600_000)
    .run();
  const wallet = privateKeyToAccount(generatePrivateKey());
  await linkWallet(id, wallet.address);
  const { headers } = await realSession(t.env, id, 'bearer');
  return { id, wallet, headers };
}

async function setCap(headers: Record<string, string>, usdc: number) {
  const res = await call(
    t.env,
    'PUT',
    '/me/limits',
    { dailyStakeCap: String(usdc * USDC) },
    headers,
  );
  expect(res.status, await res.clone().text()).toBe(200);
}

async function markUsed(roundId: string) {
  await env.DB.prepare(
    "UPDATE stakes_tickets SET used_tx = '0x" + 'ee'.repeat(32) + "' WHERE round_id = ?1",
  )
    .bind(roundId)
    .run();
}

describe('the daily cap and one live ticket per person', () => {
  it('after a merge: the losing account’s live and used tickets count for the kept account', async () => {
    const [a, b] = [await round(t), await round(t)];
    const losing = await player(t);
    const kept = await olderAccount();
    // The losing account holds a live ticket for round a.
    expect((await prepare(t, losing, a.locked.roundId, losing.wallet)).status).toBe(200);

    // It links the older account's wallet (a pending merge) and confirms by signing in to it.
    const issuedAt = new Date(T0);
    const link = await call(
      t.env,
      'POST',
      '/me/identities/link',
      { provider: 'wallet', ...(await siweBody(t.env, kept.wallet, {}, { issuedAt })) },
      losing.headers,
    );
    const { merge } = await link.json<{ merge: { id: string; keptUserId: string } }>();
    expect(merge.keptUserId).toBe(kept.id);
    const confirmed = await call(
      t.env,
      'POST',
      `/me/merges/${merge.id}/confirm`,
      { provider: 'wallet', ...(await siweBody(t.env, kept.wallet, {}, { issuedAt })) },
      losing.headers,
    );
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect((await ticketsOf(kept.id)).map((x) => x.round_id)).toEqual([a.locked.roundId]);

    // One live ticket per person and game day: the kept account can't take a second one.
    expect(await codeOf(await prepare(t, kept, b.locked.roundId, losing.wallet))).toBe(
      'ticket_live',
    );

    // Once the ticket is used (the entry is onchain), its stake counts against the cap.
    await setCap(kept.headers, 5);
    const [ticket] = await ticketsOf(kept.id);
    clockAt(t, ((ticket?.expiry ?? 0) + 31) * 1000);
    await markUsed(a.locked.roundId);
    expect(await codeOf(await prepare(t, kept, b.locked.roundId, losing.wallet))).toBe(
      'stake_cap_reached',
    );
  });

  it('after deletion and a new verification the same game day: the day’s stakes still count', async () => {
    const [a, b] = [await round(t), await round(t)];
    const gone = await player(t);
    await setCap(gone.headers, 5);
    expect((await prepare(t, gone, a.locked.roundId, gone.wallet)).status).toBe(200);
    await markUsed(a.locked.roundId);
    // Round a has become final; nothing blocks the deletion.
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'settled', final_at = ?2 WHERE round_id = ?1 AND mode = 'stakes'",
    )
      .bind(a.locked.roundId, T0)
      .run();
    const deleted = await call(t.env, 'DELETE', '/me', undefined, gone.headers);
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    // The same person verifies a new account the same game day.
    const fresh = await olderAccount();
    const wallet = await addWallet(t, fresh.id, 'US');
    const outcome = await applyVerification(
      t.env,
      fresh.id,
      gone.personId,
      { country: 'US', region: 'NJ' },
      T0 + 60_000,
    );
    expect(outcome.status).toBe('verified');
    expect(
      await env.DB.prepare('SELECT daily_stake_cap FROM limits WHERE user_id = ?1')
        .bind(fresh.id)
        .first(),
    ).toEqual({ daily_stake_cap: 5 * USDC });
    expect((await ticketsOf(fresh.id)).map((x) => x.round_id)).toEqual([a.locked.roundId]);
    const res = await prepare(t, fresh, b.locked.roundId, wallet);
    expect(await codeOf(res)).toBe('stake_cap_reached');
  });
});
