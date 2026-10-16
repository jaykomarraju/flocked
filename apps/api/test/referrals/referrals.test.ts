// Referrals (spec "Share cards and distribution" › Referral; "Anti-abuse" › Points farming):
// qualification by the invitee's first valid Free entry in a settled daily round (never a room
// round, Stakes or a refund), 100 points each once both pass the daily grant's farming rule, at
// most 10 rewards per inviter per ISO week, never twice, and GET /me/referrals.
import { env } from 'cloudflare:test';
import { ReferralsResponseSchema } from '@flocked/shared';
import { custom } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import {
  REFERRAL,
  REFERRAL_DEPS,
  referralsOnModeFinal,
  rewardQualified,
} from '../../src/referrals/reward.js';
import { me } from '../../src/routes/me.js';
import { fakeUser, withFixedClock, withSession } from '../helpers/index.js';
import { resetTables, seedDay, seedUser, ulid, userId } from '../stats/helpers.js';

const DAY = 86_400_000;
/** Thursday 2026-10-08, after that day's close: game day 10-08, ISO week 2026-W41. */
const NOW = Date.UTC(2026, 9, 9, 2);

let next = 0;
/** A fresh user (IDs never repeat in this file: the ledger keeps its rows). */
async function user(
  o: {
    ageMs?: number;
    identity?: 'farcaster' | 'wallet' | 'wallet-tx' | null;
    status?: 'active' | 'deleted';
    handle?: string | null;
  } = {},
) {
  next += 1;
  const id = await seedUser(next, {
    createdAt: NOW - (o.ageMs ?? 10 * DAY),
    ...(o.status ? { status: o.status } : {}),
    ...(o.handle !== undefined ? { handle: o.handle } : {}),
  });
  const identity = o.identity === undefined ? 'farcaster' : o.identity;
  if (identity) {
    await env.DB.prepare(
      `INSERT INTO identities (id, user_id, provider, external_id, verified_at, data_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        ulid('I', next),
        id,
        identity === 'farcaster' ? 'farcaster' : 'wallet',
        identity === 'farcaster' ? `fid-${next}` : `0x${String(next).padStart(40, 'a')}`,
        NOW - 20 * DAY,
        identity === 'wallet-tx' ? JSON.stringify({ priorTxAt: NOW - DAY }) : '{}',
      )
      .run();
  }
  return id;
}

async function refer(referrer: string, referee: string, at = NOW - 5 * DAY) {
  await env.DB.prepare(
    "INSERT INTO referrals (referrer_user_id, referee_user_id, status, created_at) VALUES (?1, ?2, 'pending', ?3)",
  )
    .bind(referrer, referee, at)
    .run();
}

const atNow = (t = NOW): Env => withFixedClock(env, t);

/** A settled daily Free round on `day` with these valid entrants (plus a loser). */
async function settledFree(day: string, entrants: string[], extra: { valid?: 0 | 1 } = {}) {
  return seedDay({
    day,
    modes: {
      free: {
        status: 'settled',
        winner: 0,
        entries: [
          ...entrants.map((u) => ({
            user: u,
            option: 0 as const,
            ...(extra.valid !== undefined ? { valid: extra.valid } : {}),
          })),
          { user: userId(9000 + next), option: 1 },
        ],
      },
    },
  });
}

async function finalFree(roundId: string, outcome: 'settled' | 'refunded' = 'settled', t = NOW) {
  await referralsOnModeFinal(atNow(t), { roundId, mode: 'free', kind: 'daily', outcome });
}

async function referral(referee: string) {
  return env.DB.prepare(
    'SELECT status, qualified_round_id, rewarded_at, reward_week FROM referrals WHERE referee_user_id = ?1',
  )
    .bind(referee)
    .first<{
      status: string;
      qualified_round_id: string | null;
      rewarded_at: number | null;
      reward_week: string | null;
    }>();
}

async function referralPoints(user: string) {
  const ledger = await env.DB.prepare(
    "SELECT delta, ref_id FROM points_ledger WHERE user_id = ?1 AND reason = 'referral'",
  )
    .bind(user)
    .all<{ delta: number; ref_id: string }>();
  const balance = await env.DB.prepare(
    "SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = 'global'",
  )
    .bind(user)
    .first<{ balance: number }>();
  return { ledger: ledger.results, balance: balance?.balance ?? 0 };
}

beforeEach(resetTables);
afterEach(() => {
  delete REFERRAL_DEPS.transport;
});

describe('qualification', () => {
  it("qualifies on the invitee's first valid Free entry in a settled daily round", async () => {
    const inviter = await user();
    const invitee = await user();
    await refer(inviter, invitee);
    const first = await settledFree('2026-10-08', [invitee]);
    await finalFree(first.roundId);
    expect(await referral(invitee)).toMatchObject({
      status: 'rewarded',
      qualified_round_id: first.roundId,
    });
    // A later settled round never moves it.
    const later = await settledFree('2026-10-09', [invitee]);
    await finalFree(later.roundId, 'settled', NOW + DAY);
    expect((await referral(invitee))?.qualified_round_id).toBe(first.roundId);
  });

  it('an invalid entry, a refunded round, a room round and Stakes never qualify', async () => {
    const inviter = await user();
    const [a, b, c, d] = [await user(), await user(), await user(), await user()];
    for (const x of [a, b, c, d]) await refer(inviter, x);
    const invalid = await settledFree('2026-10-05', [a], { valid: 0 });
    await finalFree(invalid.roundId);
    const refunded = await seedDay({
      day: '2026-10-06',
      modes: { free: { status: 'refunded', entries: [{ user: b, option: 0, payout: 100 }] } },
    });
    await finalFree(refunded.roundId, 'refunded');
    const room = await seedDay({
      day: '2026-10-07',
      kind: 'room',
      modes: { free: { status: 'settled', winner: 0, entries: [{ user: c, option: 0 }] } },
    });
    await referralsOnModeFinal(atNow(), {
      roundId: room.roundId,
      mode: 'free',
      kind: 'room',
      outcome: 'settled',
    });
    const stakes = await seedDay({
      day: '2026-10-08',
      modes: { stakes: { status: 'settled', winner: 0, entries: [{ user: d, option: 0 }] } },
    });
    await referralsOnModeFinal(atNow(), {
      roundId: stakes.roundId,
      mode: 'stakes',
      kind: 'daily',
      outcome: 'settled',
    });
    for (const x of [a, b, c, d]) expect((await referral(x))?.status).toBe('pending');
  });
});

describe('reward', () => {
  it('gives both users 100 global points once, however often the hook runs', async () => {
    const inviter = await user();
    const invitee = await user();
    await refer(inviter, invitee);
    const r = await settledFree('2026-10-08', [invitee]);
    await finalFree(r.roundId);
    await finalFree(r.roundId);
    await Promise.all([finalFree(r.roundId), finalFree(r.roundId)]);
    expect(await referral(invitee)).toMatchObject({
      status: 'rewarded',
      rewarded_at: NOW,
      reward_week: '2026-W41',
    });
    for (const u of [inviter, invitee]) {
      expect(await referralPoints(u)).toEqual({
        ledger: [{ delta: REFERRAL.bonus, ref_id: invitee }],
        balance: 100,
      });
    }
  });

  it('waits until both pass the farming rule (24 hours and a Farcaster or used wallet)', async () => {
    const inviter = await user({ identity: null });
    const invitee = await user({ ageMs: 3_600_000 }); // signed up an hour ago
    await refer(inviter, invitee, NOW - 3_600_000);
    const r = await settledFree('2026-10-08', [invitee]);
    await finalFree(r.roundId);
    expect(await referral(invitee)).toMatchObject({ status: 'qualified', rewarded_at: null });
    expect((await referralPoints(invitee)).balance).toBe(0);

    // A day later the invitee is old enough, but the inviter has no qualifying identity yet.
    const r2 = await settledFree('2026-10-09', []);
    await finalFree(r2.roundId, 'settled', NOW + DAY);
    expect((await referral(invitee))?.status).toBe('qualified');

    await env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES ('01K8I000000000000000009999', ?1, 'farcaster', 'fid-late', ?2)",
    )
      .bind(inviter, NOW + DAY)
      .run();
    const r3 = await settledFree('2026-10-10', []);
    await finalFree(r3.roundId, 'refunded', NOW + 2 * DAY);
    expect(await referral(invitee)).toMatchObject({ status: 'rewarded', reward_week: '2026-W41' });
    expect((await referralPoints(inviter)).balance).toBe(100);
  });

  it("reads a wallet's onchain history over RPC, and a failed read counts as not eligible", async () => {
    const inviter = await user({ identity: 'wallet-tx' });
    const invitee = await user({ identity: 'wallet' });
    await refer(inviter, invitee);
    const r = await settledFree('2026-10-08', [invitee]);
    REFERRAL_DEPS.transport = custom({
      request: () => Promise.reject(new Error('rpc down')),
    });
    await finalFree(r.roundId);
    expect((await referral(invitee))?.status).toBe('qualified');

    REFERRAL_DEPS.transport = custom({
      request: ({ method }: { method: string }) =>
        Promise.resolve(
          method === 'eth_getTransactionCount' ? '0x3' : method === 'eth_getCode' ? '0x' : '0x7a69',
        ),
    });
    await finalFree(r.roundId);
    expect((await referral(invitee))?.status).toBe('rewarded');
  });

  it('never rewards a deleted account', async () => {
    const inviter = await user({ status: 'deleted', handle: null });
    const invitee = await user();
    await refer(inviter, invitee);
    const r = await settledFree('2026-10-08', [invitee]);
    await finalFree(r.roundId);
    expect((await referral(invitee))?.status).toBe('qualified');
    expect((await referralPoints(invitee)).balance).toBe(0);
  });
});

describe('the weekly cap', () => {
  it('rewards at most 10 per inviter per ISO week, even under concurrent calls; the rest wait for next week', async () => {
    const inviter = await user();
    const invitees: string[] = [];
    for (let i = 0; i < 12; i++) {
      const x = await user();
      invitees.push(x);
      await refer(inviter, x, NOW - 5 * DAY + i);
    }
    const r = await settledFree('2026-10-08', invitees);
    await env.DB.prepare(
      "UPDATE referrals SET status = 'qualified', qualified_round_id = ?1 WHERE referrer_user_id = ?2",
    )
      .bind(r.roundId, inviter)
      .run();
    const i = { roundId: r.roundId, gameDay: '2026-10-08', now: NOW };
    const done = await Promise.all([1, 2, 3].map(() => rewardQualified(atNow(), i)));
    expect(done.reduce((a, b) => a + b, 0)).toBe(10);
    expect((await referralPoints(inviter)).balance).toBe(10 * REFERRAL.bonus);
    const statuses = await Promise.all(invitees.map((x) => referral(x)));
    expect(statuses.filter((s) => s?.status === 'rewarded')).toHaveLength(10);
    expect(statuses.filter((s) => s?.status === 'qualified')).toHaveLength(2);

    // Sunday 10-11 is still week 41; Monday 10-12 is week 42.
    expect(
      await rewardQualified(atNow(), { ...i, gameDay: '2026-10-11', now: NOW + 3 * DAY }),
    ).toBe(0);
    expect(
      await rewardQualified(atNow(), { ...i, gameDay: '2026-10-12', now: NOW + 4 * DAY }),
    ).toBe(2);
    expect((await referralPoints(inviter)).balance).toBe(12 * REFERRAL.bonus);
    const weeks = await env.DB.prepare(
      'SELECT reward_week, COUNT(*) AS n FROM referrals WHERE referrer_user_id = ?1 GROUP BY reward_week ORDER BY reward_week',
    )
      .bind(inviter)
      .all();
    expect(weeks.results).toEqual([
      { reward_week: '2026-W41', n: 10 },
      { reward_week: '2026-W42', n: 2 },
    ]);
  });
});

describe('GET /me/referrals', () => {
  it("lists the caller's invitees newest first with the points earned", async () => {
    const inviter = await user({ handle: 'shepherd_b' });
    const rewardedInvitee = await user({ handle: 'lamb_one' });
    const pending = await user({ handle: 'lamb_two' });
    const gone = await user({ handle: null, status: 'deleted' });
    await refer(inviter, rewardedInvitee, NOW - 3 * DAY);
    await refer(inviter, pending, NOW - 2 * DAY);
    await refer(inviter, gone, NOW - DAY);
    const r = await settledFree('2026-10-08', [rewardedInvitee]);
    await finalFree(r.roundId);

    const app = withSession(me, fakeUser({ id: inviter }));
    const res = await app.request('/me/referrals', {}, env);
    expect(res.status).toBe(200);
    const body = ReferralsResponseSchema.parse(await res.json());
    expect(body.refCode).toMatch(/^REF/);
    expect(body.rewardTotal).toBe('100');
    expect(body.referrals).toEqual([
      {
        status: 'pending',
        refereeHandle: null,
        qualifiedRoundId: null,
        createdAt: NOW - DAY,
        rewardedAt: null,
      },
      {
        status: 'pending',
        refereeHandle: 'lamb_two',
        qualifiedRoundId: null,
        createdAt: NOW - 2 * DAY,
        rewardedAt: null,
      },
      {
        status: 'rewarded',
        refereeHandle: 'lamb_one',
        qualifiedRoundId: r.roundId,
        createdAt: NOW - 3 * DAY,
        rewardedAt: NOW,
      },
    ]);
    // The invitee's own bonus counts in their total.
    const mine = await withSession(me, fakeUser({ id: rewardedInvitee })).request(
      '/me/referrals',
      {},
      env,
    );
    expect(ReferralsResponseSchema.parse(await mine.json())).toMatchObject({
      referrals: [],
      rewardTotal: '100',
    });
  });
});
