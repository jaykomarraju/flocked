// W6-F1 review fixes in `POST /rounds/:id/entries/stakes/prepare` (src/stakes/prepare.ts, cap.ts):
//   - R10: a room round answers a signed-in non-member exactly as an unknown round does, before any
//     check that would say the round exists (spec "API" › Reveal gating);
//   - R13: a used ticket for (round, person) blocks the conditional insert, whatever the wallet;
//   - O2: the daily cap counts an unused ticket until the indexer has processed past its expiry
//     (spec "Identity and personhood" › Entry tickets (Stakes)), not only until expiry + 30 s;
//   - the signer's kill-switch refusal answers `stakes_disabled`, and the unsigned row's delete is
//     retried.
import { env } from 'cloudflare:test';
import { MAX_DAILY_STAKE_CAP_KEY, gameDayOf, type StakesPrepareResponse } from '@flocked/shared';
import type { Hex } from 'viem';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { indexedThroughSec } from '../../src/stakes/cap.js';
import { DROP_TICKET_ATTEMPTS, insertTicket } from '../../src/stakes/prepare.js';
import { deploymentOf } from '../../src/chain/client.js';
import { seedFixture } from '../helpers/index.js';
import { raceBefore, setStatus } from '../identity/race.js';
import { HOUR } from '../round-do/helpers.js';
import {
  T0,
  addWallet,
  clockAt,
  codeOf,
  dispatchAll,
  indexedAt,
  join,
  player,
  prepare,
  round,
  setStakesConfig,
  stakesTest,
  ticketsOf,
  type StakesTest,
} from './helpers.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

let t: StakesTest;
beforeEach(async () => {
  await setStakesConfig({});
  t = stakesTest();
});

const USDC = 1_000_000;

async function ok(res: Response): Promise<StakesPrepareResponse> {
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json<StakesPrepareResponse>();
}

async function answer(res: Response) {
  return { status: res.status, body: await res.json<unknown>() };
}

async function setCap(userId: string, cap: number) {
  await env.DB.prepare(
    'INSERT INTO limits (user_id, daily_stake_cap) VALUES (?1, ?2) ' +
      'ON CONFLICT (user_id) DO UPDATE SET daily_stake_cap = excluded.daily_stake_cap',
  )
    .bind(userId, cap)
    .run();
}

describe('R10: a room round is invisible to a non-member', () => {
  it('a non-member gets the unknown round’s 404, even where a member would hear the round isn’t open', async () => {
    const p = await player(t);
    const unknown = await answer(await prepare(t, p, '01K7ZZZZZZZZZZZZZZZZZZZZZZ', p.wallet));
    expect(unknown).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    // An open room round, and one that hasn't opened yet.
    const open = await round(t, { kind: 'room' });
    const later = await round(t, { kind: 'room', opensAt: T0 + HOUR });
    for (const r of [open, later]) {
      expect(await answer(await prepare(t, p, r.locked.roundId, p.wallet))).toEqual(unknown);
    }
    expect(await ticketsOf(p.id)).toEqual([]);
    expect(t.signer.calls).toEqual([]);
    // A member of the later round hears that it isn't open.
    await join(later, p.id);
    expect(await codeOf(await prepare(t, p, later.locked.roundId, p.wallet))).toBe(
      'round_not_open',
    );
  });
});

describe('R13: a used ticket blocks another ticket for the round, whatever the wallet', () => {
  it('the conditional insert refuses a second-wallet ticket once the first is used, live or not', async () => {
    const r = await round(t);
    const p = await player(t);
    const first = await ok(await prepare(t, p, r.locked.roundId, p.wallet));
    // The entry is onchain: the ticket is used (the request's own entry check already passed).
    await env.DB.prepare('UPDATE stakes_tickets SET used_tx = ?2 WHERE user_id = ?1')
      .bind(p.id, `0x${'ee'.repeat(32)}`)
      .run();
    const second = await addWallet(t, p.id, 'US');
    const ticketHash: Hex = `0x${'5e'.repeat(32)}`;
    const personTag = first.ticket.personTag as Hex;
    const row = {
      ticketHash,
      roundId: r.locked.roundId,
      personTag,
      userId: p.id,
      wallet: second,
      issuedAt: T0,
      gameDay: gameDayOf(Math.floor(r.locked.closesAt / 1000)),
    };
    for (const atSec of [T0 / 1000 + 10, first.ticket.expiry + 3_600]) {
      expect(await insertTicket(env.DB, { ...row, expiry: atSec + 300 }, atSec)).toBe(false);
    }
    expect((await ticketsOf(p.id)).map((x) => x.wallet)).toEqual([p.wallet]);
    // Through the route: already entered.
    clockAt(t, (first.ticket.expiry + 3_600) * 1000);
    expect(await codeOf(await prepare(t, p, r.locked.roundId, second))).toBe('already_entered');
  });
});

describe('O2: an unused ticket counts until the indexer has processed past its expiry', () => {
  it('past expiry + 30 s it still counts until a processed block is stamped after its expiry', async () => {
    const [a, b] = [await round(t), await round(t)];
    const p = await player(t);
    await setCap(p.id, 5 * USDC);
    const issued = await ok(await prepare(t, p, a.locked.roundId, p.wallet));
    const expiry = issued.ticket.expiry;
    clockAt(t, (expiry + 120) * 1000);
    const capped = async () => codeOf(await prepare(t, p, b.locked.roundId, p.wallet));

    // No indexer position yet, then one stamped before or at the expiry: it still counts.
    expect(await capped()).toBe('stake_cap_reached');
    await indexedAt(expiry - 10);
    expect(await capped()).toBe('stake_cap_reached');
    await indexedAt(expiry);
    expect(await capped()).toBe('stake_cap_reached');
    // Past the expiry, but an event at or before it is mirrored and not yet handled (an `Entered`
    // that would mark the ticket used): it still counts.
    await indexedAt(expiry - 1, { pending: true, blocksAfter: 100 });
    const escrow = deploymentOf(env).escrow;
    expect(await indexedThroughSec(env.DB, Number(env.CHAIN_ID), escrow)).toBe(expiry - 2);
    expect(await capped()).toBe('stake_cap_reached');
    // Handled: 100 blocks past an event a second before expiry is past it (≥ 1 s per block).
    await dispatchAll();
    expect(await indexedThroughSec(env.DB, Number(env.CHAIN_ID), escrow)).toBe(expiry + 99);
    await ok(await prepare(t, p, b.locked.roundId, p.wallet));
  });

  it('a used ticket and a live one count whatever the indexer has processed', async () => {
    const [a, b, c] = [await round(t), await round(t), await round(t)];
    const p = await player(t);
    await setCap(p.id, 10 * USDC);
    const used = await ok(await prepare(t, p, a.locked.roundId, p.wallet));
    await env.DB.prepare('UPDATE stakes_tickets SET used_tx = ?2 WHERE user_id = ?1')
      .bind(p.id, `0x${'ef'.repeat(32)}`)
      .run();
    clockAt(t, (used.ticket.expiry + 60) * 1000);
    await ok(await prepare(t, p, b.locked.roundId, p.wallet));
    await indexedAt(used.ticket.expiry + 3_600);
    // 5 (used) + 5 (live) + 5 > 10.
    expect(await codeOf(await prepare(t, p, c.locked.roundId, p.wallet))).toBe('stake_cap_reached');
  });
});

describe('signer failures', () => {
  it('a kill-switch refusal from the signer answers stakes_disabled and drops the row', async () => {
    const r = await round(t);
    const p = await player(t);
    Object.assign(t.env, {
      SIGNER: {
        signTicket: () => Promise.reject(new Error('ticket_refused: stakes_disabled')),
      },
    });
    const res = await prepare(t, p, r.locked.roundId, p.wallet);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('stakes_disabled');
    expect(await ticketsOf(p.id)).toEqual([]);
  });

  it('a failed delete of the unsigned row is retried', async () => {
    const r = await round(t);
    const p = await player(t);
    t.signer.fail = true;
    // The first deletes fail; the last attempt succeeds.
    let failures = DROP_TICKET_ATTEMPTS - 1;
    const db = t.env.DB;
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'prepare') {
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        }
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.startsWith('DELETE FROM stakes_tickets')) return stmt;
          return {
            bind: (...args: unknown[]) => ({
              run: () =>
                failures-- > 0
                  ? Promise.reject(new Error('D1_ERROR: network connection lost'))
                  : stmt.bind(...args).run(),
            }),
          };
        };
      },
    });
    Object.assign(t.env, { DB: flaky });
    const res = await prepare(t, p, r.locked.roundId, p.wallet);
    Object.assign(t.env, { DB: db });
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('unavailable');
    expect(failures).toBe(-1);
    expect(await ticketsOf(p.id)).toEqual([]);
    t.signer.fail = false;
    await ok(await prepare(t, p, r.locked.roundId, p.wallet));
  });
});

describe('O3: no region code, and an age21 entry names a region of the request country', () => {
  it('21 is required: an 18+ attestation gets tos_required; with the region code it is 18 again', async () => {
    const r = await round(t);
    const p = await player(t);
    await setStakesConfig({ allow: ['US'], age21: ['US-NJ'] });
    const res = await prepare(t, p, r.locked.roundId, p.wallet, { country: 'US' });
    const body = await res.json<{ error?: { code?: string; message?: string } }>();
    expect(body.error).toMatchObject({
      code: 'tos_required',
      message: expect.stringMatching(/age/) as unknown,
    });
    expect(await ticketsOf(p.id)).toEqual([]);
    await ok(await prepare(t, p, r.locked.roundId, p.wallet, { country: 'US', regionCode: 'NY' }));
  });
});

// W7-F1 R3: the cap in force is never more than `limits.stakes.maxDailyCap`, so a stored cap above
// a maximum legal has lowered is held to it at ticket issue.
describe('R3: the maximum daily cap holds at ticket issue', () => {
  it('a cap stored above a lowered maximum is held to the maximum', async () => {
    const r = await round(t);
    const p = await player(t);
    await setCap(p.id, 900 * USDC);
    await env.DB.prepare('INSERT INTO config (key, value_json, updated_at) VALUES (?1, ?2, 0)')
      .bind(MAX_DAILY_STAKE_CAP_KEY, JSON.stringify(String(4 * USDC)))
      .run();
    // The round's stake is 5 USDC: over the 4 USDC maximum, though well under the stored 900.
    expect(await codeOf(await prepare(t, p, r.locked.roundId, p.wallet))).toBe('stake_cap_reached');
    expect(await ticketsOf(p.id)).toEqual([]);
    await setStakesConfig({});
    await ok(await prepare(t, p, r.locked.roundId, p.wallet));
  });
});

// W7-F1 R11: the ticket insert itself requires an active account, so a suspension or deletion that
// lands after the eligibility check (the race seam runs it just before the insert) issues nothing.
describe('R11: a suspension or deletion racing /prepare issues no ticket', () => {
  it('the conditional insert refuses; the answer names the account state', async () => {
    for (const [status, answer] of [
      ['suspended', 'account_suspended'],
      ['deleted', 'account_deleted'],
    ] as const) {
      const r = await round(t);
      const p = await player(t);
      const race = raceBefore(t.env, { sql: /^INSERT INTO stakes_tickets/ }, () =>
        setStatus(p.id, status),
      );
      const res = await prepare(t, p, r.locked.roundId, p.wallet);
      race.restore();
      expect(race.fired()).toBe(true);
      expect(await codeOf(res)).toBe(answer);
      expect(await ticketsOf(p.id)).toEqual([]);
    }
    expect(t.signer.calls).toEqual([]);
  });
});
