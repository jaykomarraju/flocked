// The daily grant's anti-farming rule (spec "Anti-abuse" › Points farming; owner decision Oct 9, 2026):
// an account at least 24 h old with a linked Farcaster identity or a wallet with a prior onchain
// transaction. An ineligible user gets no grant and no skip row, so linking later that day still works.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import { describe, expect, it } from 'vitest';
import {
  applyDailyGrant,
  dailyGrantEligible,
  recordPriorTransactions,
} from '../../src/rounds/grant.js';
import { FakeChain } from '../anchor-do/fake-chain.js';
import { drand } from '../anchor-do/helpers.js';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const DAY = 24 * 3_600_000;

async function user(o: { ageMs: number; balance?: number }): Promise<string> {
  const id = newUlid();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, handle, role, status, ref_code, created_at) VALUES (?1, ?2, 'user', 'active', ?3, ?4)",
    ).bind(id, `u_${id.slice(-10).toLowerCase()}`, `R${id.slice(-12)}`, NOW - o.ageMs),
    env.DB.prepare(
      "INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, 'global', ?2, 0)",
    ).bind(id, o.balance ?? 500),
  ]);
  return id;
}

async function link(
  userId: string,
  provider: 'farcaster' | 'wallet' | 'email',
  externalId: string,
) {
  await env.DB.prepare(
    'INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(newUlid(), userId, provider, externalId, NOW - 2 * DAY)
    .run();
}

async function grantRows(userId: string, roundId: string) {
  const ledger = await env.DB.prepare(
    "SELECT delta FROM points_ledger WHERE user_id = ?1 AND reason = 'daily_grant' AND ref_id = ?2",
  )
    .bind(userId, roundId)
    .all();
  const skip = await env.DB.prepare(
    'SELECT balance FROM daily_grant_skips WHERE user_id = ?1 AND round_id = ?2',
  )
    .bind(userId, roundId)
    .first();
  return { ledger: ledger.results, skip };
}

const wallet = () => `0x${crypto.randomUUID().replaceAll('-', '').padEnd(40, '0')}`;

describe('daily grant anti-farming', () => {
  it('grants an account ≥ 24 h old with a linked Farcaster identity', async () => {
    const u = await user({ ageMs: DAY });
    await link(u, 'farcaster', `fid-${u}`);
    const roundId = newUlid();
    expect(await dailyGrantEligible(env.DB, { userId: u, now: NOW })).toBe(true);
    expect(await applyDailyGrant(env.DB, { userId: u, roundId, now: NOW })).toMatchObject({
      status: 'applied',
    });
    expect((await grantRows(u, roundId)).ledger).toEqual([{ delta: 100 }]);
  });

  it('an account under 24 h old gets no grant and no skip row', async () => {
    const u = await user({ ageMs: DAY - 1, balance: 1500 });
    await link(u, 'farcaster', `fid-${u}`);
    const roundId = newUlid();
    expect(await applyDailyGrant(env.DB, { userId: u, roundId, now: NOW })).toEqual({
      status: 'skipped',
    });
    expect(await grantRows(u, roundId)).toEqual({ ledger: [], skip: null });
  });

  it('an email-only or unverified link is not enough, and linking later the same day still works', async () => {
    const u = await user({ ageMs: 3 * DAY });
    await link(u, 'email', `${u}@example.com`);
    const roundId = newUlid();
    expect(await applyDailyGrant(env.DB, { userId: u, roundId, now: NOW })).toEqual({
      status: 'skipped',
    });
    expect(await grantRows(u, roundId)).toEqual({ ledger: [], skip: null });
    await link(u, 'farcaster', `fid-${u}`);
    expect(
      await applyDailyGrant(env.DB, { userId: u, roundId, now: NOW + 3_600_000 }),
    ).toMatchObject({ status: 'applied' });
  });

  it('an eligible user at ≥ 1,000 still gets the final skip row', async () => {
    const u = await user({ ageMs: DAY, balance: 1000 });
    await link(u, 'farcaster', `fid-${u}`);
    const roundId = newUlid();
    await applyDailyGrant(env.DB, { userId: u, roundId, now: NOW });
    expect(await grantRows(u, roundId)).toEqual({ ledger: [], skip: { balance: 1000 } });
  });

  it('a wallet counts once it has a prior onchain transaction (an EOA nonce or a deployed smart wallet)', async () => {
    const fake = new FakeChain({ genesis: drand.genesis, period: drand.period }, NOW / 1000);
    const deps = { transport: fake.transport };
    const roundId = newUlid();

    const fresh = await user({ ageMs: 2 * DAY });
    await link(fresh, 'wallet', wallet());
    await recordPriorTransactions(env, { userId: fresh, roundId, now: NOW }, deps);
    expect(await applyDailyGrant(env.DB, { userId: fresh, roundId, now: NOW })).toEqual({
      status: 'skipped',
    });
    expect(await grantRows(fresh, roundId)).toEqual({ ledger: [], skip: null });

    const eoa = await user({ ageMs: 2 * DAY });
    const eoaAddr = wallet();
    await link(eoa, 'wallet', eoaAddr);
    fake.nonces.set(eoaAddr, 3);
    await recordPriorTransactions(env, { userId: eoa, roundId, now: NOW }, deps);
    expect(await applyDailyGrant(env.DB, { userId: eoa, roundId, now: NOW })).toMatchObject({
      status: 'applied',
    });

    const smart = await user({ ageMs: 2 * DAY });
    const smartAddr = wallet();
    await link(smart, 'wallet', smartAddr);
    fake.code.set(smartAddr, '0x6080');
    await recordPriorTransactions(env, { userId: smart, roundId, now: NOW }, deps);
    expect(await dailyGrantEligible(env.DB, { userId: smart, now: NOW })).toBe(true);
  });

  it('reads the chain only when it could change the grant, and survives an RPC failure', async () => {
    const fake = new FakeChain({ genesis: drand.genesis, period: drand.period }, NOW / 1000);
    const roundId = newUlid();
    const young = await user({ ageMs: DAY / 2 });
    await link(young, 'wallet', wallet());
    const fc = await user({ ageMs: 2 * DAY });
    await link(fc, 'wallet', wallet());
    await link(fc, 'farcaster', `fid-${fc}`);
    fake.failNext.set('eth_getTransactionCount', 99);
    for (const u of [young, fc]) {
      await recordPriorTransactions(
        env,
        { userId: u, roundId, now: NOW },
        { transport: fake.transport },
      );
    }
    expect(fake.failNext.get('eth_getTransactionCount')).toBe(99); // no read at all

    const flaky = await user({ ageMs: 2 * DAY });
    await link(flaky, 'wallet', wallet());
    await expect(
      recordPriorTransactions(
        env,
        { userId: flaky, roundId, now: NOW },
        { transport: fake.transport },
      ),
    ).resolves.toBeUndefined();
    expect(await dailyGrantEligible(env.DB, { userId: flaky, now: NOW })).toBe(false);
  });
});
