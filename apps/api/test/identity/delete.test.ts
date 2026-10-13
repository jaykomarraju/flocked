// ID-1 (deletion): DELETE /me anonymizes the account and every account merged into it, removes
// identities and sessions, keeps ledger and entry rows under the opaque ID, writes the person
// tombstone with the cap state (W5-Z carry-over), expires pending merges, queues the share cards
// for a re-render, and is refused while self-excluded, suspended, or a round is not final.
import { env } from 'cloudflare:test';
import { newUlid, type CardsMessage } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { seedFixture } from '../helpers/index.js';
import { call, errorCode, siweBody } from '../auth/fixtures.js';
import {
  DAY,
  account,
  balance,
  exclude,
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

class CardsQueue {
  readonly sent: CardsMessage[] = [];
  send(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }
  sendBatch(batch: { body: CardsMessage }[]): Promise<void> {
    this.sent.push(...batch.map((m) => m.body));
    return Promise.resolve();
  }
}

async function withCards(): Promise<IdentityTest & { cards: CardsQueue }> {
  const t = await identityEnv();
  const cards = new CardsQueue();
  Object.assign(t.env, { QUEUE_CARDS: cards as unknown as Env['QUEUE_CARDS'] });
  return { ...t, cards };
}

async function del(t: IdentityTest, who: Account) {
  return call(t.env, 'DELETE', '/me', undefined, who.headers);
}

describe('DELETE /me', () => {
  it('anonymizes, removes sign-in, keeps the ledger and entries, tombstones the person', async () => {
    const t = await withCards();
    const a = await account(t, { points: 640 });
    const personId = `0x${'de'.repeat(32)}`;
    const roundId = await freeEntry(a.id, 'settled');
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET display_name = 'Dolly', avatar_url = 'https://x.test/a.png', prefs_json = '{\"show_stakes_net\":true}', " +
          "person_id = ?2, kyc_status = 'verified', person_verified_at = 3, coinbase_country = 'US', coinbase_region = 'NJ' WHERE id = ?1",
      ).bind(a.id, personId),
      env.DB.prepare(
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'coinbase', ?3, 3)",
      ).bind(newUlid(Date.now()), a.id, personId),
      env.DB.prepare(
        'INSERT INTO limits (user_id, daily_stake_cap, pending_cap, pending_cap_effective_at) VALUES (?1, 20000000, 50000000, ?2)',
      ).bind(a.id, Date.now() + 3600_000),
      env.DB.prepare(
        "INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) VALUES (?1, ?2, 'global', 140, 'payout', ?3, 1)",
      ).bind(newUlid(Date.now()), a.id, roundId),
      env.DB.prepare(
        "INSERT INTO notification_prefs (user_id, channel, event, enabled) VALUES (?1, 'email', 'outcome', 1)",
      ).bind(a.id),
      env.DB.prepare(
        "INSERT INTO share_cards (share_id, round_id, mode, user_id, kind, r2_prefix, created_at) VALUES (?1, ?2, 'free', ?3, 'result', 'cards/x', 1)",
      ).bind(`share${a.id}`, roundId, a.id),
    ]);

    const res = await del(t, a);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie().join(';')).toMatch(/flocked_session=;|Max-Age=0/);

    expect(await userRow(a.id)).toMatchObject({
      status: 'deleted',
      handle: null,
      display_name: null,
      avatar_url: null,
      prefs_json: '{}',
      person_id: null,
      kyc_status: null,
      coinbase_country: null,
    });
    expect(await identitiesOf(a.id)).toEqual([]);
    expect((await call(t.env, 'GET', '/me', undefined, a.headers)).status).toBe(401);
    // Ledger, balances and entries stay under the opaque ID.
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ?1')
          .bind(a.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(await balance(a.id)).toBe(640);
    expect(
      await env.DB.prepare('SELECT 1 AS ok FROM entries WHERE user_id = ?1').bind(a.id).first(),
    ).toEqual({ ok: 1 });
    expect(
      await env.DB.prepare('SELECT 1 FROM notification_prefs WHERE user_id = ?1')
        .bind(a.id)
        .first(),
    ).toBeNull();
    // The tombstone keeps the cap state and the account, for the person's next verification.
    expect(
      await env.DB.prepare(
        'SELECT daily_stake_cap, pending_cap, user_id FROM person_tombstones WHERE person_id = ?1',
      )
        .bind(personId)
        .first(),
    ).toEqual({ daily_stake_cap: 20_000_000, pending_cap: 50_000_000, user_id: a.id });
    // The cards are re-rendered without handle and avatar.
    expect(t.cards.sent).toEqual([
      { roundId, mode: 'free', userId: a.id, kind: 'result', variants: ['og', 'embed', 'square'] },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT actor_user_id FROM audit_log WHERE action = 'account_deleted' AND target = ?1",
      )
        .bind(a.id)
        .first(),
    ).toEqual({ actor_user_id: a.id });
    // The wallet signs in to nothing now: SIWE creates a fresh account.
    const signIn = await call(t.env, 'POST', '/auth/siwe/verify', {
      ...(await siweBody(t.env, a.wallet)),
      turnstileToken: 'ok',
    });
    expect(await signIn.json()).toMatchObject({ created: true });
  });

  it('anonymizes the accounts merged into it and expires its pending merges', async () => {
    const t = await withCards();
    const kept = await account(t, { createdAt: Date.now() - 60 * DAY });
    const losing = await account(t);
    const first = await pendingMerge(t, losing, await walletProof(t.env, kept.wallet));
    const ok = await call(
      t.env,
      'POST',
      `/me/merges/${first.id}/confirm`,
      await walletProof(t.env, kept.wallet),
      losing.headers,
    );
    expect(ok.status).toBe(200);
    // Another account starts a merge with the kept account; deletion expires it.
    const third = await account(t);
    const open = await pendingMerge(t, third, await walletProof(t.env, kept.wallet));

    expect((await del(t, kept)).status).toBe(200);
    expect(await userRow(losing.id)).toMatchObject({
      status: 'merged',
      handle: null,
      display_name: null,
      prefs_json: '{}',
    });
    expect((await mergeRow(open.id))?.status).toBe('expired');
    expect((await userRow(third.id))?.status).toBe('active');
  });

  it('refused while a round is not final, a ticket is live, self-excluded or suspended', async () => {
    const t = await withCards();
    const a = await account(t);
    const round = await freeEntry(a.id, 'revealing');
    let res = await del(t, a);
    expect([res.status, await errorCode(res)]).toEqual([409, 'deletion_blocked']);
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'refunded', final_at = 1 WHERE round_id = ?1",
    )
      .bind(round)
      .run();

    await env.DB.prepare(
      "INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at, game_day) VALUES (?1, ?2, '0xtag', ?3, '0xw', ?4, 1, '2026-10-08')",
    )
      .bind(`0x${a.id}`, round, a.id, Math.floor(Date.now() / 1000) + 200)
      .run();
    res = await del(t, a);
    expect([res.status, await errorCode(res)]).toEqual([409, 'deletion_blocked']);
    await env.DB.prepare('UPDATE stakes_tickets SET expiry = 1 WHERE user_id = ?1')
      .bind(a.id)
      .run();

    await exclude(a.id, Date.now() + DAY);
    res = await del(t, a);
    expect([res.status, await errorCode(res)]).toEqual([403, 'self_excluded']);
    await env.DB.prepare('DELETE FROM limits WHERE user_id = ?1').bind(a.id).run();

    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(a.id).run();
    res = await del(t, a);
    expect([res.status, await errorCode(res)]).toEqual([403, 'account_suspended']);
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?1").bind(a.id).run();

    expect((await userRow(a.id))?.status).toBe('active');
    expect((await del(t, a)).status).toBe(200);
  });
});
