// ID-1 (merges): a pending merge is confirmed only by signing in to the other account; every
// refusal rule holds; the kept account (created first) takes the person ID, the lower cap and any
// pending increase, the identities, the balances per scope through paired `merge` ledger rows, the
// room memberships and ownership; the whole move is one atomic batch; the 30-day limit; merges the
// personhood callback creates are confirmed the same way (W5-Z carry-over).
import { env } from 'cloudflare:test';
import { ConfirmMergeResponseSchema, newUlid } from '@flocked/shared';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { mergedCapState } from '../../src/identity/merge.js';
import { applyVerification } from '../../src/personhood/verify.js';
import { seedFixture } from '../helpers/index.js';
import { call, errorCode } from '../auth/fixtures.js';
import { raceBefore } from './race.js';
import {
  DAY,
  account,
  balance,
  confirm,
  exclude,
  farcasterProof,
  freeEntry,
  identitiesOf,
  identityEnv,
  mergeRow,
  pendingMerge,
  userRow,
  walletProof,
  type Account,
  type IdentityTest,
} from './fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

const USDC = 1_000_000;

/** An older account K and a newer one L, with a pending merge L started by linking K's wallet. */
async function pair(t: IdentityTest, opts: { keptPoints?: number; losingPoints?: number } = {}) {
  const kept = await account(t, {
    createdAt: Date.now() - 60 * DAY,
    points: opts.keptPoints ?? 700,
  });
  const losing = await account(t, { points: opts.losingPoints ?? 300 });
  const merge = await pendingMerge(t, losing, await walletProof(t.env, kept.wallet));
  expect(merge.keptUserId).toBe(kept.id);
  return { kept, losing, merge };
}

async function room(ownerId: string, members: [string, 'owner' | 'member', number][]) {
  const id = newUlid(Date.now());
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO rooms (id, name, owner_user_id, invite_code, created_at) VALUES (?1, ?2, ?3, ?4, 1)',
    ).bind(id, 'flock', ownerId, `INV${id.slice(-8)}`),
    ...members.flatMap(([user, role, points]) => [
      env.DB.prepare(
        'INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 5)',
      ).bind(id, user, role),
      env.DB.prepare(
        'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, ?3, 1)',
      ).bind(user, id, points),
    ]),
  ]);
  return id;
}

async function ledger(userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT scope, delta, ref_id FROM points_ledger WHERE user_id = ?1 AND reason = 'merge' ORDER BY scope",
  )
    .bind(userId)
    .all<{ scope: string; delta: number; ref_id: string }>();
  return results;
}

async function blocked(t: IdentityTest, who: Account, mergeId: string, body: unknown) {
  const res = await confirm(t, who, mergeId, body);
  const { error } = await res.json<{ error: { code: string; message: string } }>();
  expect([res.status, error.code]).toEqual([409, 'merge_blocked']);
  return error.message;
}

describe('POST /me/merges/:id/confirm: the transfer', () => {
  it('moves everything to the kept account in one batch, with paired ledger rows per scope', async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    const personId = `0x${'5a'.repeat(32)}`;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET person_id = ?2, kyc_status = 'verified', person_verified_at = 7, coinbase_country = 'US', coinbase_region = 'NJ' WHERE id = ?1",
      ).bind(losing.id, personId),
      env.DB.prepare(
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'coinbase', ?3, 7)",
      ).bind(newUlid(now), losing.id, personId),
      // L: cap 50 USDC, with a raise to 200 USDC waiting 10 more hours. K: the default cap, with a
      // raise to 300 USDC waiting 5 more hours.
      env.DB.prepare(
        'INSERT INTO limits (user_id, daily_stake_cap, pending_cap, pending_cap_effective_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind(losing.id, 50 * USDC, 200 * USDC, now + 10 * 3600_000),
      env.DB.prepare(
        'INSERT INTO limits (user_id, pending_cap, pending_cap_effective_at) VALUES (?1, ?2, ?3)',
      ).bind(kept.id, 300 * USDC, now + 5 * 3600_000),
    ]);
    const owned = await room(losing.id, [[losing.id, 'owner', 40]]);
    const both = await room(kept.id, [
      [kept.id, 'owner', 5],
      [losing.id, 'member', 7],
    ]);
    const theirs = await room(kept.id, [[kept.id, 'owner', 10]]);
    const losingSession = losing.headers;

    const res = await confirm(t, losing, merge.id, await farcasterProof(t, kept.fid));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = ConfirmMergeResponseSchema.parse(await res.json());
    expect(body.merge).toMatchObject({ id: merge.id, status: 'confirmed', keptUserId: kept.id });

    // The losing account: merged into K, sessions revoked, nothing left.
    expect(await userRow(losing.id)).toMatchObject({
      status: 'merged',
      merged_into: kept.id,
      person_id: null,
    });
    expect((await call(t.env, 'GET', '/me', undefined, losingSession)).status).toBe(401);
    expect(await identitiesOf(losing.id)).toEqual([]);
    // Person ID and verification data, and every identity, the coinbase one included.
    expect(await userRow(kept.id)).toMatchObject({
      person_id: personId,
      kyc_status: 'verified',
      person_verified_at: 7,
      coinbase_country: 'US',
    });
    expect((await identitiesOf(kept.id)).map((i) => i.provider).sort()).toEqual([
      'coinbase',
      'farcaster',
      'farcaster',
      'wallet',
      'wallet',
    ]);
    // Balances per scope, through paired merge rows referencing the merge.
    expect([await balance(kept.id), await balance(losing.id)]).toEqual([1000, 0]);
    expect(await balance(kept.id, owned)).toBe(40);
    expect(await balance(kept.id, both)).toBe(12);
    expect(await balance(kept.id, theirs)).toBe(10);
    const scopes = ['global', owned, both].sort();
    expect((await ledger(losing.id)).map((r) => [r.scope, r.delta, r.ref_id])).toEqual(
      scopes.map((s) => [
        s,
        -({ global: 300, [owned]: 40, [both]: 7 } as Record<string, number>)[s]!,
        merge.id,
      ]),
    );
    expect((await ledger(kept.id)).map((r) => [r.scope, r.delta])).toEqual(
      scopes.map((s) => [
        s,
        ({ global: 300, [owned]: 40, [both]: 7 } as Record<string, number>)[s]!,
      ]),
    );
    // Rooms: memberships and ownership.
    const members = await env.DB.prepare(
      'SELECT room_id, user_id, role FROM room_members WHERE room_id IN (?1, ?2) ORDER BY room_id',
    )
      .bind(owned, both)
      .all<{ room_id: string; user_id: string; role: string }>();
    expect(members.results.map((m) => [m.room_id, m.user_id, m.role])).toEqual(
      [
        [owned, kept.id, 'owner'],
        [both, kept.id, 'owner'],
      ].sort(),
    );
    expect(
      await env.DB.prepare('SELECT owner_user_id FROM rooms WHERE id = ?1').bind(owned).first(),
    ).toEqual({ owner_user_id: kept.id });
    // The lower cap (50, L's) and L's pending raise with its original timer; K's raise is dropped
    // (only the side whose cap is in force keeps its raise: owner decision B3b, Oct 12).
    expect(
      await env.DB.prepare(
        'SELECT daily_stake_cap, pending_cap, pending_cap_effective_at FROM limits WHERE user_id = ?1',
      )
        .bind(kept.id)
        .first(),
    ).toEqual({
      daily_stake_cap: 50 * USDC,
      pending_cap: 200 * USDC,
      pending_cap_effective_at: now + 10 * 3600_000,
    });
    // An audit row and a notice to the kept account.
    expect(
      await env.DB.prepare(
        "SELECT actor, actor_user_id, target, json_extract(data_json, '$.mergeId') AS merge FROM audit_log WHERE action = 'merge_confirmed' AND target = ?1",
      )
        .bind(kept.id)
        .first(),
    ).toEqual({ actor: 'user', actor_user_id: losing.id, target: kept.id, merge: merge.id });
    expect(
      t.notify.messages.map((m) => [m.userId, m.event === 'security_notice' && m.payload.kind]),
    ).toEqual([
      [kept.id, 'merge_pending'],
      [kept.id, 'merge_completed'],
    ]);
    // The kept account signs in with the losing account's identities now.
    const signIn = await call(t.env, 'POST', '/auth/farcaster', {
      token: await t.fc.mint(losing.fid),
    });
    expect(await signIn.json()).toMatchObject({ user: { id: kept.id }, created: false });

    // Confirming again changes nothing.
    const again = await confirm(t, kept, merge.id, await walletProof(t.env, kept.wallet));
    expect(again.status).toBe(200);
    expect(await ledger(kept.id)).toHaveLength(3);
  });

  it('either side may confirm; the kept account confirms by signing in to the losing one', async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    const res = await confirm(t, kept, merge.id, await walletProof(t.env, losing.wallet));
    expect(res.status).toBe(200);
    expect((await userRow(losing.id))?.status).toBe('merged');
    expect([await balance(kept.id), await balance(losing.id)]).toEqual([1000, 0]);
  });

  it('is atomic: a statement failing late in the batch leaves both accounts untouched', async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    await env.DB.prepare(
      "CREATE TRIGGER fail_merge BEFORE UPDATE OF status ON users WHEN NEW.status = 'merged' " +
        "BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    ).run();
    try {
      const res = await confirm(t, losing, merge.id, await walletProof(t.env, kept.wallet));
      expect(res.status).toBe(500);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_merge').run();
    }
    expect((await mergeRow(merge.id))?.status).toBe('pending');
    expect([await balance(kept.id), await balance(losing.id)]).toEqual([700, 300]);
    expect(await ledger(kept.id)).toEqual([]);
    expect(await ledger(losing.id)).toEqual([]);
    expect(await identitiesOf(losing.id)).toHaveLength(2);
    expect((await userRow(losing.id))?.status).toBe('active');
    // And the retry goes through.
    expect((await confirm(t, losing, merge.id, await walletProof(t.env, kept.wallet))).status).toBe(
      200,
    );
    expect([await balance(kept.id), await balance(losing.id)]).toEqual([1000, 0]);
  });
});

describe('POST /me/merges/:id/confirm: who may confirm', () => {
  it("only proof of the other account's own sign-in identity confirms", async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    const stranger = await account(t);
    for (const proof of [
      await walletProof(t.env, losing.wallet), // the caller's own
      await walletProof(t.env, stranger.wallet), // a third account
      await walletProof(t.env, privateKeyToAccount(generatePrivateKey())), // nobody's
    ]) {
      const res = await confirm(t, losing, merge.id, proof);
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
    }
    expect((await mergeRow(merge.id))?.status).toBe('pending');
    // A third account cannot even see it.
    const res = await confirm(t, stranger, merge.id, await walletProof(t.env, kept.wallet));
    expect(res.status).toBe(404);
  });

  it('expires after 7 days', async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    await env.DB.prepare('UPDATE merges SET expires_at = ?2 WHERE id = ?1')
      .bind(merge.id, Date.now() - 1)
      .run();
    const res = await confirm(t, losing, merge.id, await walletProof(t.env, kept.wallet));
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('merge_expired');
    expect((await mergeRow(merge.id))?.status).toBe('expired');
    // A new link starts a new pending merge for the same pair.
    const fresh = await pendingMerge(t, losing, await walletProof(t.env, kept.wallet));
    expect(fresh.id).not.toBe(merge.id);
  });
});

describe('POST /me/merges/:id/confirm: refusals', () => {
  it('either account with an entry in a round that is not final', async () => {
    const t = await identityEnv();
    for (const side of ['kept', 'losing'] as const) {
      const p = await pair(t);
      const round = await freeEntry(p[side].id, 'revealing');
      expect(
        await blocked(t, p.losing, p.merge.id, await walletProof(t.env, p.kept.wallet)),
      ).toMatch(/not final/);
      // Once the round is final the merge goes through.
      await env.DB.prepare(
        "UPDATE round_modes SET status = 'settled', final_at = 1 WHERE round_id = ?1",
      )
        .bind(round)
        .run();
      expect(
        (await confirm(t, p.losing, p.merge.id, await walletProof(t.env, p.kept.wallet))).status,
      ).toBe(200);
    }
  });

  it('different person IDs: refused for good', async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET person_id = ?2 WHERE id = ?1').bind(
        kept.id,
        `0x${'01'.repeat(32)}`,
      ),
      env.DB.prepare('UPDATE users SET person_id = ?2 WHERE id = ?1').bind(
        losing.id,
        `0x${'02'.repeat(32)}`,
      ),
    ]);
    expect(await blocked(t, losing, merge.id, await walletProof(t.env, kept.wallet))).toMatch(
      /different/,
    );
    expect((await mergeRow(merge.id))?.status).toBe('refused');
  });

  it('a suspended account: the other side is refused, and the suspended caller cannot write', async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(kept.id).run();
    expect(await blocked(t, losing, merge.id, await walletProof(t.env, kept.wallet))).toMatch(
      /suspended/,
    );
    const res = await confirm(t, kept, merge.id, await walletProof(t.env, losing.wallet));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('account_suspended');
  });

  it('a self-excluded account (timed or permanent)', async () => {
    const t = await identityEnv();
    const a = await pair(t);
    await exclude(a.kept.id, Date.now() + DAY);
    expect(await blocked(t, a.losing, a.merge.id, await walletProof(t.env, a.kept.wallet))).toMatch(
      /self-excluded/,
    );
    const b = await pair(t);
    await exclude(b.losing.id, null, true);
    expect(await blocked(t, b.losing, b.merge.id, await walletProof(t.env, b.kept.wallet))).toMatch(
      /self-excluded/,
    );
  });

  it('the kept account already received a merge in the last 30 days', async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    const earlier = await account(t);
    const insertConfirmed = (at: number) =>
      env.DB.prepare(
        "INSERT INTO merges (id, kept_user_id, losing_user_id, identity_id, status, expires_at, created_at, confirmed_at) VALUES (?1, ?2, ?3, 'x', 'confirmed', ?4, ?4, ?4)",
      )
        .bind(newUlid(at), kept.id, earlier.id, at)
        .run();
    await insertConfirmed(Date.now() - 29 * DAY);
    expect(await blocked(t, losing, merge.id, await walletProof(t.env, kept.wallet))).toMatch(
      /30 days/,
    );
    await env.DB.prepare("DELETE FROM merges WHERE kept_user_id = ?1 AND status = 'confirmed'")
      .bind(kept.id)
      .run();
    await insertConfirmed(Date.now() - 31 * DAY);
    expect((await confirm(t, losing, merge.id, await walletProof(t.env, kept.wallet))).status).toBe(
      200,
    );
  });
});

// W7-F1: no chained merges (R10), and a confirmation that races a change the guards must see
// rolls back (R9, R10). The race seam runs the change after every read, just before the batch.
describe('POST /me/merges/:id/confirm: W7-F1 races and chained merges', () => {
  const confirmedInto = (keptId: string, losingId: string, at: number) =>
    env.DB.prepare(
      "INSERT INTO merges (id, kept_user_id, losing_user_id, identity_id, status, expires_at, created_at, confirmed_at) VALUES (?1, ?2, ?3, 'x', 'confirmed', ?4, ?4, ?4)",
    )
      .bind(newUlid(at), keptId, losingId, at)
      .run();

  it('R10: refused while the account to be merged away received a merge in the last 30 days', async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    const earlier = await account(t);
    await confirmedInto(losing.id, earlier.id, Date.now() - 29 * DAY);
    expect(await blocked(t, losing, merge.id, await walletProof(t.env, kept.wallet))).toMatch(
      /merged away received a merge in the last 30 days/,
    );
    // A transient refusal: the merge stays pending.
    expect((await mergeRow(merge.id))?.status).toBe('pending');
    await env.DB.prepare("DELETE FROM merges WHERE kept_user_id = ?1 AND status = 'confirmed'")
      .bind(losing.id)
      .run();
    await confirmedInto(losing.id, earlier.id, Date.now() - 31 * DAY);
    expect((await confirm(t, losing, merge.id, await walletProof(t.env, kept.wallet))).status).toBe(
      200,
    );
  });

  it('R10: a merge into the losing account confirmed meanwhile rolls the confirmation back', async () => {
    const t = await identityEnv();
    const { kept, losing, merge } = await pair(t);
    const other = await account(t);
    const proof = await walletProof(t.env, kept.wallet);
    const race = raceBefore(t.env, { batchOf: 10 }, () =>
      confirmedInto(losing.id, other.id, Date.now()),
    );
    const res = await confirm(t, losing, merge.id, proof);
    race.restore();
    expect(race.fired()).toBe(true);
    expect([res.status, await errorCode(res)]).toEqual([409, 'conflict']);
    expect((await mergeRow(merge.id))?.status).toBe('pending');
    expect((await userRow(losing.id))?.status).toBe('active');
  });

  it('R9: a person ID bound to either account meanwhile rolls the confirmation back', async () => {
    for (const side of ['losing', 'kept'] as const) {
      const t = await identityEnv();
      const p = await pair(t);
      const personId = `0x${(side === 'losing' ? '6a' : '6b').repeat(32)}`;
      const proof = await walletProof(t.env, p.kept.wallet);
      const race = raceBefore(t.env, { batchOf: 10 }, () =>
        env.DB.prepare("UPDATE users SET person_id = ?2, kyc_status = 'verified' WHERE id = ?1")
          .bind(p[side].id, personId)
          .run(),
      );
      const res = await confirm(t, p.losing, p.merge.id, proof);
      race.restore();
      expect(race.fired()).toBe(true);
      expect([side, res.status, await errorCode(res)]).toEqual([side, 409, 'conflict']);
      expect(await userRow(p.losing.id)).toMatchObject({ status: 'active', merged_into: null });
      expect((await mergeRow(p.merge.id))?.status).toBe('pending');
    }
  });
});

// W5-Z carry-over: the personhood callback creates pending merges (never merges); they are
// confirmed like any other.
describe('a pending merge from the personhood callback', () => {
  it('is confirmed by signing in to the account that holds the person ID', async () => {
    const t = await identityEnv();
    const holder = await account(t, { createdAt: Date.now() - 90 * DAY, points: 100 });
    const starter = await account(t, { points: 50 });
    const personId = `0x${'9c'.repeat(32)}`;
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET person_id = ?2, kyc_status = 'verified' WHERE id = ?1").bind(
        holder.id,
        personId,
      ),
      env.DB.prepare(
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'coinbase', ?3, 1)",
      ).bind(newUlid(Date.now()), holder.id, personId),
    ]);
    const outcome = await applyVerification(
      t.env,
      starter.id,
      personId,
      { country: 'US', region: 'NJ' },
      Date.now(),
    );
    if (outcome.status !== 'merge_pending') throw new Error(outcome.status);
    expect(outcome.merge).toMatchObject({
      provider: 'coinbase',
      keptUserId: holder.id,
      losingUserId: starter.id,
    });
    // Nothing merged inside the callback.
    expect((await userRow(starter.id))?.status).toBe('active');
    expect((await userRow(starter.id))?.person_id).toBeNull();

    const res = await confirm(
      t,
      starter,
      outcome.merge.id,
      await walletProof(t.env, holder.wallet),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await userRow(starter.id)).toMatchObject({ status: 'merged', merged_into: holder.id });
    expect((await userRow(holder.id))?.person_id).toBe(personId);
    expect(await balance(holder.id)).toBe(150);
  });
});

describe('mergedCapState', () => {
  const t = 1_000_000;
  const row = (cap: number | null, pending: number | null = null, at: number | null = null) => ({
    daily_stake_cap: cap,
    pending_cap: pending,
    pending_cap_effective_at: at,
    question_block_until: null,
  });
  it('takes the lower cap in force; none set on either side stays unset', () => {
    expect(mergedCapState(null, null, t).daily_stake_cap).toBeNull();
    expect(mergedCapState(row(30), null, t).daily_stake_cap).toBe(30);
    expect(mergedCapState(row(300 * USDC), null, t).daily_stake_cap).toBe(100 * USDC);
    // A raise past its 24 hours is the cap in force.
    expect(mergedCapState(row(10, 80, t - 1), row(60), t).daily_stake_cap).toBe(60);
  });
  it('keeps only the waiting raise of the side whose cap is in force, with its own timer (B3b)', () => {
    expect(mergedCapState(row(10, 80, t + 5), row(20, 90, t + 9), t)).toMatchObject({
      daily_stake_cap: 10,
      pending_cap: 80,
      pending_cap_effective_at: t + 5,
    });
    expect(mergedCapState(row(50, 60, t + 5), row(70), t)).toMatchObject({ pending_cap: 60 });
    // The other side's raise is dropped, even when the side in force has none.
    expect(mergedCapState(row(5), row(50, 80, t + 5), t)).toEqual({
      daily_stake_cap: 5,
      pending_cap: null,
      pending_cap_effective_at: null,
      question_block_until: null,
    });
    expect(mergedCapState(row(20, 90, t + 9), row(10, 30, t + 5), t)).toMatchObject({
      daily_stake_cap: 10,
      pending_cap: 30,
      pending_cap_effective_at: t + 5,
    });
    // A raise past its 24 hours is that side's cap in force.
    expect(mergedCapState(row(10, 80, t - 1), row(60, 90, t + 5), t)).toMatchObject({
      daily_stake_cap: 60,
      pending_cap: 90,
      pending_cap_effective_at: t + 5,
    });
    // A raise no higher than the merged cap is dropped.
    expect(mergedCapState(row(50), row(50, 40, t + 5), t)).toMatchObject({ pending_cap: null });
  });
  it('equal caps: the lower waiting raise with its own timer; on a tie the later timer', () => {
    expect(mergedCapState(row(20, 80, t + 5), row(20, 60, t + 9), t)).toMatchObject({
      daily_stake_cap: 20,
      pending_cap: 60,
      pending_cap_effective_at: t + 9,
    });
    expect(mergedCapState(row(20, 60, t + 9), row(20, 60, t + 5), t)).toMatchObject({
      pending_cap: 60,
      pending_cap_effective_at: t + 9,
    });
    // Both at the default cap (none set): either raise may survive.
    expect(mergedCapState(null, row(null, 150 * USDC, t + 5), t)).toMatchObject({
      daily_stake_cap: 100 * USDC,
      pending_cap: 150 * USDC,
      pending_cap_effective_at: t + 5,
    });
  });
});
