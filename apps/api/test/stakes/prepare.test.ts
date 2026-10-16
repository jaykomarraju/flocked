// ID-5: `POST /rounds/:id/entries/stakes/prepare` refuses every ineligible branch with its own code
// and issues a signed ticket otherwise (spec "Identity and personhood" › Entry tickets (Stakes);
// "Compliance and responsible play"; "Modes: Free and Stakes" flags). Also AC-4's API half (one
// person, one ticket per round, whatever the wallet), concurrency (one conditional insert per
// person), the daily cap across game days, and NFR-8 (no person tag or person ID in a log).
import { env } from 'cloudflare:test';
import {
  API_BASE_PATH,
  StakesPrepareResponseSchema,
  TosStateSchema,
  ticketDigest,
  type StakesPrepareResponse,
} from '@flocked/shared';
import { recoverAddress, type Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app.js';
import { deploymentOf } from '../../src/chain/client.js';
import { personTag } from '../../src/stakes/person-tag.js';
import { TICKET_TTL_SEC } from '../../src/stakes/cap.js';
import { ORIGIN, TOS } from '../auth/fixtures.js';
import { seedFixture } from '../helpers/index.js';
import { BASE_OPENS_AT, HOUR } from '../round-do/helpers.js';
import {
  T0,
  TEST_PERSON_TAG_KEY,
  addWallet,
  clockAt,
  codeOf,
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

async function ok(res: Response): Promise<StakesPrepareResponse> {
  expect(res.status, await res.clone().text()).toBe(200);
  return StakesPrepareResponseSchema.parse(await res.json());
}

const DAY_MS = 24 * HOUR;
const USDC = 1_000_000;

describe('ID-5: an eligible player gets a signed ticket', () => {
  it('records the ticket, then the signer signs its EIP-712 digest; the response is what enter needs', async () => {
    const r = await round(t);
    const p = await player(t);
    const body = await ok(await prepare(t, p, r.locked.roundId, p.wallet));

    const escrow = deploymentOf(env).escrow.toLowerCase();
    expect(body).toMatchObject({
      ticket: { roundId: r.chainRoundId, wallet: p.wallet },
      chainId: 31337,
      verifyingContract: escrow,
      stake: '5000000',
      beaconRound: r.locked.beaconRound,
    });
    expect(body.ticket.expiry).toBe(T0 / 1000 + TICKET_TTL_SEC);
    expect(body.ticket.personTag).toBe(await personTag(t.env, p.personId, r.locked.roundId));

    const digest = ticketDigest(
      { chainId: body.chainId, verifyingContract: body.verifyingContract as Hex },
      {
        roundId: BigInt(body.ticket.roundId),
        wallet: body.ticket.wallet as Hex,
        personTag: body.ticket.personTag as Hex,
        expiry: BigInt(body.ticket.expiry),
      },
    );
    expect(await recoverAddress({ hash: digest, signature: body.signature as Hex })).toBe(
      t.signer.address,
    );
    // The fake signer refuses a hash without a row, so the row was committed before the call.
    expect(t.signer.calls).toHaveLength(1);
    expect(await ticketsOf(p.id)).toEqual([
      {
        ticket_hash: digest.toLowerCase(),
        round_id: r.locked.roundId,
        person_tag: body.ticket.personTag,
        user_id: p.id,
        wallet: p.wallet,
        expiry: body.ticket.expiry,
        issued_at: T0,
        used_tx: null,
        game_day: '2026-10-08',
      },
    ]);
  });

  it('any linked wallet holding both attestations satisfies the country check; the entering one need not (Oct 12)', async () => {
    const r = await round(t);
    const p = await player(t);
    const bare = await addWallet(t, p.id, null);
    const body = await ok(await prepare(t, p, r.locked.roundId, bare));
    expect(body.ticket.wallet).toBe(bare);
  });

  it('person tags are per person and per round', async () => {
    const [a, b] = [await round(t), await round(t)];
    const [p, q] = [await player(t), await player(t)];
    const tags = [
      await personTag(t.env, p.personId, a.locked.roundId),
      await personTag(t.env, p.personId, b.locked.roundId),
      await personTag(t.env, q.personId, a.locked.roundId),
    ];
    expect(new Set(tags).size).toBe(3);
    for (const tag of tags) expect(tag).toMatch(/^0x[0-9a-f]{64}$/);
    // HMAC-SHA256(PERSON_TAG_KEY, "flocked/personTag/v1" ‖ person_id ‖ roundId).
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(TEST_PERSON_TAG_KEY.slice(2).match(/../g)!, (h) => parseInt(h, 16)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`flocked/personTag/v1${p.personId}${a.locked.roundId}`),
      ),
    );
    expect(tags[0]).toBe(`0x${Array.from(mac, (x) => x.toString(16).padStart(2, '0')).join('')}`);
  });
});

describe('ID-5: every ineligible branch is refused with its reason, and no ticket is recorded', () => {
  async function refused(
    res: Response,
    code: string,
    userId: string,
    message?: RegExp,
  ): Promise<void> {
    const body: { error?: { code?: string; message?: string } } = await res.json();
    expect(body.error?.code, JSON.stringify(body)).toBe(code);
    if (message) expect(body.error?.message).toMatch(message);
    expect(await ticketsOf(userId)).toEqual([]);
  }

  it('the kill switch: mode.stakes.enabled off (or unset) stops tickets immediately', async () => {
    const r = await round(t);
    const p = await player(t);
    await setStakesConfig({ enabled: false });
    await refused(await prepare(t, p, r.locked.roundId, p.wallet), 'stakes_disabled', p.id);
    await setStakesConfig({ enabled: null });
    await refused(await prepare(t, p, r.locked.roundId, p.wallet), 'stakes_disabled', p.id);
    expect(t.signer.calls).toEqual([]);
    await setStakesConfig({});
    await ok(await prepare(t, p, r.locked.roundId, p.wallet));
  });

  it('geo: the request location or the verified country off the allow list', async () => {
    const r = await round(t);
    const p = await player(t);
    await refused(
      await prepare(t, p, r.locked.roundId, p.wallet, { country: 'FR' }),
      'ineligible',
      p.id,
      /where you are/,
    );
    // A region rule allows only that region of the request location.
    await setStakesConfig({ allow: ['US-NJ'] });
    await refused(
      await prepare(t, p, r.locked.roundId, p.wallet, { country: 'US', regionCode: 'NY' }),
      'ineligible',
      p.id,
      /where you are/,
    );
    // The verified country must be allowed too.
    await setStakesConfig({ allow: ['FR'] });
    const fr = await player(t, { country: 'US' });
    await refused(
      await prepare(t, fr, r.locked.roundId, fr.wallet, { country: 'FR' }),
      'ineligible',
      fr.id,
      /where you are/,
    );
  });

  it('geo: no attested wallet, or an attested country unlike the Coinbase country', async () => {
    const r = await round(t);
    const none = await player(t, { attested: null });
    await refused(
      await prepare(t, none, r.locked.roundId, none.wallet),
      'ineligible',
      none.id,
      /verified-country attestation/,
    );
    await setStakesConfig({ allow: ['US', 'CA'] });
    const mismatch = await player(t, { country: 'US', attested: 'CA' });
    await refused(
      await prepare(t, mismatch, r.locked.roundId, mismatch.wallet),
      'ineligible',
      mismatch.id,
      /doesn't match/,
    );
  });

  it('proxy signals: Tor and a low bot score', async () => {
    const r = await round(t);
    const p = await player(t);
    await refused(
      await prepare(t, p, r.locked.roundId, p.wallet, {
        country: 'US',
        regionCode: 'NJ',
        botManagement: { score: 5 },
      }),
      'ineligible',
      p.id,
      /VPN, proxy or Tor/,
    );
    await refused(
      await prepare(t, p, r.locked.roundId, p.wallet, { country: 'T1' }),
      'ineligible',
      p.id,
    );
  });

  it('not verified, ToS out of date, self-excluded, suspended', async () => {
    const r = await round(t);
    const unverified = await player(t);
    await env.DB.prepare("UPDATE users SET kyc_status = 'unverified' WHERE id = ?1")
      .bind(unverified.id)
      .run();
    await refused(
      await prepare(t, unverified, r.locked.roundId, unverified.wallet),
      'not_verified',
      unverified.id,
    );

    const stale = await player(t);
    await env.DB.prepare("UPDATE users SET tos_version = 'old' WHERE id = ?1").bind(stale.id).run();
    await refused(
      await prepare(t, stale, r.locked.roundId, stale.wallet),
      'tos_required',
      stale.id,
      /terms/,
    );

    const excluded = await player(t);
    await env.DB.prepare(
      'INSERT INTO limits (user_id, self_exclusion_started_at, self_exclusion_until) VALUES (?1, ?2, ?3)',
    )
      .bind(excluded.id, T0 - HOUR, T0 + 7 * DAY_MS)
      .run();
    await refused(
      await prepare(t, excluded, r.locked.roundId, excluded.wallet),
      'self_excluded',
      excluded.id,
    );

    const suspended = await player(t);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1")
      .bind(suspended.id)
      .run();
    await refused(
      await prepare(t, suspended, r.locked.roundId, suspended.wallet),
      'account_suspended',
      suspended.id,
    );
  });

  it('age: 21+ where geo.stakes.age21 lists the request region; an 18+ attestation is not enough', async () => {
    const r = await round(t);
    const p = await player(t);
    await setStakesConfig({ age21: ['US-NJ'] });
    await refused(await prepare(t, p, r.locked.roundId, p.wallet), 'tos_required', p.id, /age/);
    // From a region that isn't listed, 18+ is enough.
    await setStakesConfig({ allow: ['US'], age21: ['US-NJ'] });
    await ok(await prepare(t, p, r.locked.roundId, p.wallet, { country: 'US', regionCode: 'NY' }));
  });

  it('age: 21+ where geo.stakes.age21 lists the verified country, from anywhere allowed', async () => {
    const r = await round(t);
    await setStakesConfig({ allow: ['CA', 'US'], age21: ['CA'] });
    const p = await player(t, { country: 'CA' });
    await refused(
      await prepare(t, p, r.locked.roundId, p.wallet, { country: 'US', regionCode: 'NJ' }),
      'tos_required',
      p.id,
      /age/,
    );
    // A region entry names the request location only, never the verified country.
    await setStakesConfig({ allow: ['CA', 'US'], age21: ['CA-QC'] });
    await ok(await prepare(t, p, r.locked.roundId, p.wallet, { country: 'US', regionCode: 'NJ' }));
  });

  it('age: GET /me names 21 in the checkbox, POST /me/tos records 21, and then the ticket issues', async () => {
    const r = await round(t);
    const p = await player(t);
    await setStakesConfig({ age21: ['US-NJ'] });
    const nj = { country: 'US', regionCode: 'NJ' };
    const me = async () => {
      const req = new Request(`${ORIGIN}${API_BASE_PATH}/me`, { headers: p.headers, cf: nj });
      return (await app.fetch(req, t.env)).json<{ tos: unknown; stakes: { reasons: string[] } }>();
    };
    const before = await me();
    expect(TosStateSchema.parse(before.tos).ageRequired).toBe(21);
    expect(before.stakes.reasons).toContain('age_unattested');

    const accept = await app.fetch(
      new Request(`${ORIGIN}${API_BASE_PATH}/me/tos`, {
        method: 'POST',
        headers: { ...p.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ tosVersion: TOS, ageAttested: 21 }),
        cf: nj,
      }),
      t.env,
    );
    expect(accept.status).toBe(200);
    expect((await accept.json<{ tos: { ageRequired: number } }>()).tos.ageRequired).toBe(21);
    const row = await env.DB.prepare('SELECT age_attested_min FROM users WHERE id = ?1')
      .bind(p.id)
      .first<{ age_attested_min: number }>();
    expect(row?.age_attested_min).toBe(21);
    expect((await me()).stakes.reasons).not.toContain('age_unattested');
    await ok(await prepare(t, p, r.locked.roundId, p.wallet));

    // A later 18+ acceptance (from an 18+ region) never lowers a 21+ attestation.
    await app.fetch(
      new Request(`${ORIGIN}${API_BASE_PATH}/me/tos`, {
        method: 'POST',
        headers: { ...p.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ tosVersion: TOS, ageAttested: 18 }),
        cf: { country: 'US', regionCode: 'NY' },
      }),
      t.env,
    );
    const after = await env.DB.prepare('SELECT age_attested_min FROM users WHERE id = ?1')
      .bind(p.id)
      .first<{ age_attested_min: number }>();
    expect(after?.age_attested_min).toBe(21);
  });

  it('the wallet must be a verified wallet linked to the user', async () => {
    const r = await round(t);
    const p = await player(t);
    const q = await player(t);
    await refused(await prepare(t, p, r.locked.roundId, q.wallet), 'identity_required', p.id);
    await refused(
      await prepare(t, p, r.locked.roundId, '0x000000000000000000000000000000000000dead'),
      'identity_required',
      p.id,
    );
  });

  it('the round: unknown, not offered, not created onchain, not open yet, closed, mode not pending', async () => {
    const p = await player(t);
    await refused(await prepare(t, p, '01K7ZZZZZZZZZZZZZZZZZZZZZZ', p.wallet), 'not_found', p.id);
    const free = await round(t, { modes: ['free'] });
    await refused(await prepare(t, p, free.locked.roundId, p.wallet), 'mode_unavailable', p.id);

    const uncreated = await round(t);
    await env.DB.prepare(
      "UPDATE round_modes SET chain_round_id = NULL WHERE round_id = ?1 AND mode = 'stakes'",
    )
      .bind(uncreated.locked.roundId)
      .run();
    await refused(
      await prepare(t, p, uncreated.locked.roundId, p.wallet),
      'mode_unavailable',
      p.id,
    );

    const later = await round(t, { opensAt: T0 + HOUR });
    await refused(await prepare(t, p, later.locked.roundId, p.wallet), 'round_not_open', p.id);

    const r = await round(t);
    for (const status of ['revealing', 'voided']) {
      await env.DB.prepare(
        "UPDATE round_modes SET status = ?2, final_at = CASE WHEN ?2 = 'voided' THEN 1 END WHERE round_id = ?1 AND mode = 'stakes'",
      )
        .bind(r.locked.roundId, status)
        .run();
      await refused(await prepare(t, p, r.locked.roundId, p.wallet), 'mode_unavailable', p.id);
    }

    const closing = await round(t);
    clockAt(t, closing.locked.closesAt);
    await refused(await prepare(t, p, closing.locked.roundId, p.wallet), 'round_closed', p.id);
  });

  it('a void requested in the RoundDO refuses tickets while round_modes still says pending (W4-Z)', async () => {
    const r = await round(t);
    const p = await player(t);
    expect((await r.stub.requestVoid()).accepted).toBe(true);
    expect((await r.stub.getState()).voidRequested).toBe(true);
    const mode = await env.DB.prepare(
      "SELECT status FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'",
    )
      .bind(r.locked.roundId)
      .first<{ status: string }>();
    expect(mode?.status).toBe('pending');
    await refused(
      await prepare(t, p, r.locked.roundId, p.wallet),
      'mode_unavailable',
      p.id,
      /voided/,
    );
  });

  it('room rounds: members only, with an account 24 hours older than closesAt', async () => {
    await setStakesConfig({ rooms: true });
    const r = await round(t, { kind: 'room' });
    const outsider = await player(t);
    // A non-member gets the unknown round's 404 (Reveal gating; W6-F1 R10), not `not_member`.
    await refused(
      await prepare(t, outsider, r.locked.roundId, outsider.wallet),
      'not_found',
      outsider.id,
    );

    const fresh = await player(t, { createdAt: r.locked.closesAt - DAY_MS + 1 });
    await join(r, fresh.id);
    await refused(
      await prepare(t, fresh, r.locked.roundId, fresh.wallet),
      'ineligible',
      fresh.id,
      /24 hours/,
    );

    const member = await player(t, { createdAt: r.locked.closesAt - DAY_MS });
    await join(r, member.id);
    await ok(await prepare(t, member, r.locked.roundId, member.wallet));
  });

  it('room rounds: refused while the rooms kill switch rooms.stakes.enabled is off (W8-F1)', async () => {
    const r = await round(t, { kind: 'room' });
    const member = await player(t, { createdAt: r.locked.closesAt - DAY_MS });
    await join(r, member.id);
    for (const rooms of [undefined, false]) {
      await setStakesConfig(rooms === undefined ? {} : { rooms });
      await refused(
        await prepare(t, member, r.locked.roundId, member.wallet),
        'stakes_disabled',
        member.id,
        /rooms/,
      );
    }
    // The daily round is not affected; with the switch on the member gets a ticket.
    const daily = await round(t);
    const p = await player(t);
    await ok(await prepare(t, p, daily.locked.roundId, p.wallet));
    await setStakesConfig({ rooms: true });
    await ok(await prepare(t, member, r.locked.roundId, member.wallet));
  });

  it('a person who already entered the round is refused (indexed entry, or a used ticket)', async () => {
    const r = await round(t);
    const p = await player(t);
    await env.DB.prepare(
      'INSERT INTO entries (id, round_id, mode, user_id, wallet, person_tag, stake, commitment, tx_hash, block_number, log_index, created_at) ' +
        "VALUES (?1, ?2, 'stakes', ?3, ?4, ?5, 5000000, ?6, ?7, 1, 0, ?8)",
    )
      .bind(
        '01K7STAKESENTRY00000000001',
        r.locked.roundId,
        p.id,
        p.wallet,
        await personTag(t.env, p.personId, r.locked.roundId),
        `0x${'cc'.repeat(32)}`,
        `0x${'dd'.repeat(32)}`,
        T0,
      )
      .run();
    await refused(await prepare(t, p, r.locked.roundId, p.wallet), 'already_entered', p.id);

    const r2 = await round(t);
    const q = await player(t);
    await ok(await prepare(t, q, r2.locked.roundId, q.wallet));
    await env.DB.prepare('UPDATE stakes_tickets SET used_tx = ?2 WHERE user_id = ?1')
      .bind(q.id, `0x${'ee'.repeat(32)}`)
      .run();
    clockAt(t, T0 + 10 * 60_000);
    const res = await prepare(t, q, r2.locked.roundId, q.wallet);
    expect(await codeOf(res)).toBe('already_entered');
  });
});

describe('one live ticket per person per game day (AC-4, API half)', () => {
  it('one person cannot hold tickets for one round on two wallets; a new one only after expiry + 30 s, with the same tag', async () => {
    const r = await round(t);
    const p = await player(t);
    const second = await addWallet(t, p.id, 'US');
    const first = await ok(await prepare(t, p, r.locked.roundId, p.wallet));

    const live = await prepare(t, p, r.locked.roundId, second);
    expect(live.status).toBe(409);
    expect(await codeOf(live)).toBe('ticket_live');
    // The same wallet doesn't get a second ticket either.
    expect(await codeOf(await prepare(t, p, r.locked.roundId, p.wallet))).toBe('ticket_live');

    clockAt(t, (first.ticket.expiry + 30) * 1000 - 1000);
    expect(await codeOf(await prepare(t, p, r.locked.roundId, second))).toBe('ticket_live');
    clockAt(t, (first.ticket.expiry + 30) * 1000);
    const again = await ok(await prepare(t, p, r.locked.roundId, second));
    // The person tag is the person's for the round, whatever the wallet, so the escrow's
    // PersonTagUsed check refuses a second entry.
    expect(again.ticket.personTag).toBe(first.ticket.personTag);
    expect((await ticketsOf(p.id)).map((x) => x.wallet)).toEqual([p.wallet, second]);
  });

  it('a live ticket in one round blocks a ticket in another round of the same game day', async () => {
    const [a, b] = [await round(t), await round(t)];
    const p = await player(t);
    await ok(await prepare(t, p, a.locked.roundId, p.wallet));
    expect(await codeOf(await prepare(t, p, b.locked.roundId, p.wallet))).toBe('ticket_live');
  });

  it('concurrency: two simultaneous requests for one person issue one ticket', async () => {
    const r = await round(t);
    const p = await player(t);
    const other = await addWallet(t, p.id, 'US');
    const results = await Promise.all([
      prepare(t, p, r.locked.roundId, p.wallet),
      prepare(t, p, r.locked.roundId, other),
      prepare(t, p, r.locked.roundId, p.wallet),
    ]);
    const statuses = results.map((x) => x.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(await ticketsOf(p.id)).toHaveLength(1);
    expect(t.signer.calls).toHaveLength(1);

    // And across two rounds of the same game day.
    const [a, b] = [await round(t), await round(t)];
    const q = await player(t);
    const both = await Promise.all([
      prepare(t, q, a.locked.roundId, q.wallet),
      prepare(t, q, b.locked.roundId, q.wallet),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await ticketsOf(q.id)).toHaveLength(1);
  });

  it('a signer failure drops the recorded ticket and answers 503; a retry then succeeds', async () => {
    const r = await round(t);
    const p = await player(t);
    t.signer.fail = true;
    const res = await prepare(t, p, r.locked.roundId, p.wallet);
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('unavailable');
    expect(await ticketsOf(p.id)).toEqual([]);
    t.signer.fail = false;
    await ok(await prepare(t, p, r.locked.roundId, p.wallet));
  });

  it('no signer binding or no PERSON_TAG_KEY: 503 and nothing recorded', async () => {
    const r = await round(t);
    const p = await player(t);
    Object.assign(t.env, { SIGNER: undefined });
    expect(await codeOf(await prepare(t, p, r.locked.roundId, p.wallet))).toBe('unavailable');
    Object.assign(t.env, { SIGNER: t.signer, PERSON_TAG_KEY: '' });
    expect(await codeOf(await prepare(t, p, r.locked.roundId, p.wallet))).toBe('unavailable');
    expect(t.signer.calls).toEqual([]);
    expect(await ticketsOf(p.id)).toEqual([]);
  });
});

describe('ID-5: the daily cap counts indexed stakes and live tickets by game day', () => {
  async function setCap(userId: string, cap: number, pending?: { cap: number; at: number }) {
    await env.DB.prepare(
      'INSERT INTO limits (user_id, daily_stake_cap, pending_cap, pending_cap_effective_at) VALUES (?1, ?2, ?3, ?4) ' +
        'ON CONFLICT (user_id) DO UPDATE SET daily_stake_cap = excluded.daily_stake_cap, ' +
        'pending_cap = excluded.pending_cap, pending_cap_effective_at = excluded.pending_cap_effective_at',
    )
      .bind(userId, cap, pending?.cap ?? null, pending?.at ?? null)
      .run();
  }

  async function indexedEntry(roundId: string, userId: string, n: number) {
    await env.DB.prepare(
      'INSERT INTO entries (id, round_id, mode, user_id, wallet, person_tag, stake, commitment, tx_hash, block_number, log_index, created_at) ' +
        "VALUES (?1, ?2, 'stakes', ?3, ?4, ?5, 5000000, ?6, ?7, 1, ?8, ?9)",
    )
      .bind(
        `01K7STAKESCAP0000000000${String(n).padStart(3, '0')}`,
        roundId,
        userId,
        `0x${n.toString(16).padStart(40, '0')}`,
        `0x${n.toString(16).padStart(64, 'f')}`,
        `0x${'ab'.repeat(32)}`,
        `0x${n.toString(16).padStart(64, '0')}`,
        n,
        T0,
      )
      .run();
  }

  it('a live ticket holds its stake: with a 5 USDC cap the next round of the day is over the cap', async () => {
    const [a, b] = [await round(t), await round(t)];
    const p = await player(t);
    await setCap(p.id, 5 * USDC);
    await ok(await prepare(t, p, a.locked.roundId, p.wallet));
    // The cap check (live ticket counted) answers before the one-live-ticket rule would.
    expect(await codeOf(await prepare(t, p, b.locked.roundId, p.wallet))).toBe('stake_cap_reached');
  });

  it('indexed stakes count; an expired, unused ticket does not', async () => {
    const [a, b, c] = [await round(t), await round(t), await round(t)];
    const p = await player(t);
    await setCap(p.id, 10 * USDC);
    await indexedEntry(a.locked.roundId, p.id, 1);
    // 5 indexed + 5 here = 10: fits.
    const issued = await ok(await prepare(t, p, b.locked.roundId, p.wallet));
    // Past expiry + 30 s, with the indexer past its expiry (O2), the unused ticket for b no longer
    // counts: 5 indexed + 5 = 10 fits again.
    clockAt(t, (issued.ticket.expiry + 30) * 1000);
    await indexedAt(issued.ticket.expiry + 1);
    await ok(await prepare(t, p, c.locked.roundId, p.wallet));
    // But with an indexed entry in b as well, 15 would be over.
    clockAt(t, T0 + 20 * 60_000);
    await indexedEntry(b.locked.roundId, p.id, 2);
    const d = await round(t);
    expect(await codeOf(await prepare(t, p, d.locked.roundId, p.wallet))).toBe('stake_cap_reached');
  });

  it('a cap decrease applies at once; a raise only once its 24 hours have passed; the default is 100 USDC', async () => {
    const [a, b] = [await round(t), await round(t)];
    const p = await player(t);
    await indexedEntry(a.locked.roundId, p.id, 3);
    await setCap(p.id, 5 * USDC, { cap: 50 * USDC, at: T0 + HOUR });
    expect(await codeOf(await prepare(t, p, b.locked.roundId, p.wallet))).toBe('stake_cap_reached');
    clockAt(t, T0 + HOUR);
    await ok(await prepare(t, p, b.locked.roundId, p.wallet));

    const q = await player(t);
    for (let i = 0; i < 19; i++) {
      const r = await round(t);
      await indexedEntry(r.locked.roundId, q.id, 100 + i);
    }
    const twentieth = await round(t);
    await ok(await prepare(t, q, twentieth.locked.roundId, q.wallet)); // 20 × 5 = 100
    const more = await round(t);
    await indexedEntry(twentieth.locked.roundId, q.id, 200);
    clockAt(t, T0 + 2 * HOUR);
    expect(await codeOf(await prepare(t, q, more.locked.roundId, q.wallet))).toBe(
      'stake_cap_reached',
    );
  });

  it('a ticket spanning the game-day boundary counts against its round’s day, not the next', async () => {
    // Round a closes at 21:01 New York on Oct 8 (game day Oct 8); round next opens 21:00 Oct 8 and
    // closes on Oct 9 (game day Oct 9).
    const a = await round(t);
    const next = await round(t, { opensAt: BASE_OPENS_AT + DAY_MS });
    const p = await player(t);
    await setCap(p.id, 5 * USDC);
    clockAt(t, a.locked.closesAt - 60_000);
    const late = await ok(await prepare(t, p, a.locked.roundId, p.wallet));
    expect((await ticketsOf(p.id))[0]?.game_day).toBe('2026-10-08');

    // Two minutes later the old ticket is still live (expiry + 30 s ahead), yet the next day's
    // round gets a ticket: another game day, so neither the cap nor the one-live-ticket rule applies.
    clockAt(t, a.locked.closesAt + 60_000);
    expect(late.ticket.expiry + 30).toBeGreaterThan((a.locked.closesAt + 60_000) / 1000);
    const nextDay = await ok(await prepare(t, p, next.locked.roundId, p.wallet));
    expect((await ticketsOf(p.id)).map((x) => x.game_day)).toEqual(['2026-10-08', '2026-10-09']);
    expect(nextDay.ticket.personTag).not.toBe(late.ticket.personTag);

    // An indexed entry on Oct 8 doesn't count on Oct 9 either.
    await indexedEntry(a.locked.roundId, p.id, 300);
    const q = await player(t);
    await setCap(q.id, 5 * USDC);
    await indexedEntry(a.locked.roundId, q.id, 301);
    await ok(await prepare(t, q, next.locked.roundId, q.wallet));
  });
});

describe('NFR-8: person tags and person IDs never reach a log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('across issue, every refusal and a signer failure', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const [a, b] = [await round(t), await round(t)];
    const p = await player(t);
    const body = await ok(await prepare(t, p, a.locked.roundId, p.wallet));
    await prepare(t, p, b.locked.roundId, p.wallet); // ticket_live
    await prepare(t, p, a.locked.roundId, p.wallet, { country: 'FR' }); // geo
    const q = await player(t);
    t.signer.fail = true;
    await prepare(t, q, b.locked.roundId, q.wallet); // signer failure
    t.signer.fail = false;
    Object.assign(t.env, { SIGNER: undefined });
    await prepare(t, q, b.locked.roundId, q.wallet); // no binding

    const text = lines.join('\n').toLowerCase();
    expect(text).toContain('stakes_ticket_issued');
    expect(text).toContain('ticket_sign_failed');
    const secrets = [
      body.ticket.personTag,
      await personTag(t.env, q.personId, b.locked.roundId),
      p.personId,
      q.personId,
    ];
    for (const s of secrets) expect(text).not.toContain(s.slice(2).toLowerCase());
  });
});
