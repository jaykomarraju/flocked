// The person ID (spec "Identity and personhood" › Personhood): HMAC-SHA256(PERSON_ID_KEY, Coinbase
// user ID), one per user (ID-2), a pending merge when another account holds it (never a merge in
// the callback), tombstone inheritance, and NFR-8's Coinbase part: no raw Coinbase ID, name, email
// or address in D1 or KV.
import { env } from 'cloudflare:test';
import { MeResponseSchema, PersonhoodCallbackResponseSchema } from '@flocked/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { personIdFor } from '../../src/personhood/coinbase.js';
import { MERGE_PENDING_TTL_MS, applyVerification } from '../../src/personhood/verify.js';
import { realSession, seedFixture } from '../helpers/index.js';
import { raceBefore, setStatus } from '../identity/race.js';
import { call } from '../auth/fixtures.js';
import {
  TEST_PERSON_ID_KEY,
  callback,
  newUser,
  person,
  personhoodEnv,
  start,
  type CoinbasePerson,
  type PersonhoodTest,
} from './fixtures.js';

beforeAll(async () => {
  await seedFixture(env.DB);
});

afterEach(() => {
  vi.restoreAllMocks();
});

let seq = 0;
async function account(t: PersonhoodTest, createdAt = Date.now()) {
  const id = `01K70000000000000000PM${String(++seq).padStart(4, '0')}`;
  await newUser(id, createdAt);
  return { id, headers: (await realSession(t.env, id)).headers };
}

/** Runs the whole Coinbase sign-in for `headers` as `p`; returns the parsed outcome. */
async function verifyAs(t: PersonhoodTest, headers: Record<string, string>, p: CoinbasePerson) {
  const { url, state } = await start(t.env, headers);
  const res = await callback(t.env, { state, code: t.coinbase.approve(url, p) });
  expect(res.status).toBe(200);
  return PersonhoodCallbackResponseSchema.parse(await res.json());
}

const personIdOf = async (id: string) =>
  (
    await env.DB.prepare('SELECT person_id FROM users WHERE id = ?1')
      .bind(id)
      .first<{ person_id: string | null }>()
  )?.person_id ?? null;

describe('person ID', () => {
  it('is HMAC-SHA256(PERSON_ID_KEY, Coinbase user ID) as 0x hex', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const p = person(101);
    await verifyAs(t, a.headers, p);
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(TEST_PERSON_ID_KEY.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(p.id)),
    );
    const expected = `0x${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    expect(await personIdOf(a.id)).toBe(expected);
    expect(await personIdFor(t.env, p.id)).toBe(expected);
    // A different key gives a different ID (the key is what keeps raw IDs out of D1).
    expect(await personIdFor({ ...t.env, PERSON_ID_KEY: `0x${'77'.repeat(32)}` }, p.id)).not.toBe(
      expected,
    );
  });

  it('ID-2: one person ID per user: a second account with the same Coinbase account gets a pending merge', async () => {
    const t = personhoodEnv();
    const older = await account(t, Date.now() - 86_400_000);
    const newer = await account(t);
    const p = person(102);
    expect((await verifyAs(t, older.headers, p)).status).toBe('verified');
    const out = await verifyAs(t, newer.headers, p);
    expect(out).toMatchObject({
      status: 'merge_pending',
      merge: {
        status: 'pending',
        keptUserId: older.id,
        losingUserId: newer.id,
        provider: 'coinbase',
      },
    });
    if (out.status !== 'merge_pending') throw new Error('unreachable');
    expect(out.merge.expiresAt - out.merge.createdAt).toBe(MERGE_PENDING_TTL_MS);

    const pid = await personIdOf(older.id);
    const holders = await env.DB.prepare('SELECT id FROM users WHERE person_id = ?1')
      .bind(pid)
      .all();
    expect(holders.results).toEqual([{ id: older.id }]);
    expect(await personIdOf(newer.id)).toBeNull();
    const identities = await env.DB.prepare(
      "SELECT user_id FROM identities WHERE provider = 'coinbase' AND external_id = ?1",
    )
      .bind(pid)
      .all();
    expect(identities.results).toEqual([{ user_id: older.id }]);
    // Never merged inside the callback.
    const users = await env.DB.prepare('SELECT status FROM users WHERE id IN (?1, ?2)')
      .bind(older.id, newer.id)
      .all<{ status: string }>();
    expect(users.results.map((u) => u.status)).toEqual(['active', 'active']);
    // The holder is told; both accounts see the pending merge in GET /me.
    expect(t.notify.messages).toContainEqual(
      expect.objectContaining({
        userId: older.id,
        payload: expect.objectContaining({ kind: 'merge_pending' }) as unknown,
      }),
    );
    for (const who of [older, newer]) {
      const me = MeResponseSchema.parse(
        await (await call(t.env, 'GET', '/me', undefined, who.headers)).json(),
      );
      expect(me.merges.map((m) => m.id)).toEqual([out.merge.id]);
    }

    // Verifying again from the newer account reuses the open merge.
    const again = await verifyAs(t, newer.headers, p);
    expect(again.status === 'merge_pending' && again.merge.id).toBe(out.merge.id);
    const merges = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM merges WHERE losing_user_id = ?1',
    )
      .bind(newer.id)
      .first<{ n: number }>();
    expect(merges?.n).toBe(1);
  });

  it('ID-2: the earlier account is kept even when it verifies second', async () => {
    const t = personhoodEnv();
    const older = await account(t, Date.now() - 86_400_000);
    const newer = await account(t);
    const p = person(103);
    expect((await verifyAs(t, newer.headers, p)).status).toBe('verified');
    expect(await verifyAs(t, older.headers, p)).toMatchObject({
      status: 'merge_pending',
      merge: { keptUserId: older.id, losingUserId: newer.id },
    });
    expect(await personIdOf(older.id)).toBeNull();
  });

  it('ID-2: an account bound to one person cannot bind another', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    expect((await verifyAs(t, a.headers, person(104))).status).toBe('verified');
    const pid = await personIdOf(a.id);
    expect(await verifyAs(t, a.headers, person(105))).toEqual({
      status: 'failed',
      reason: 'person_mismatch',
    });
    expect(await personIdOf(a.id)).toBe(pid);
  });

  it('ID-2: two concurrent callbacks with different Coinbase accounts bind only one person', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    const p1 = await personIdFor(t.env, person(107).id);
    const p2 = await personIdFor(t.env, person(108).id);
    await env.DB.prepare(
      'INSERT INTO person_tombstones (person_id, daily_stake_cap, created_at) VALUES (?1, ?2, ?3)',
    )
      .bind(p2, 5_000_000, Date.now())
      .run();
    const location = { country: 'US', region: 'NJ' };
    // The first callback (p1) finishes between the second one's read and its batch.
    const db = t.env.DB;
    const batch = db.batch.bind(db);
    vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      expect(await applyVerification(t.env, a.id, p1, location, Date.now())).toMatchObject({
        status: 'verified',
      });
      return batch(statements);
    });
    expect(await applyVerification(t.env, a.id, p2, location, Date.now())).toEqual({
      status: 'failed',
      reason: 'person_mismatch',
    });
    expect(await personIdOf(a.id)).toBe(p1);
    const ids = await env.DB.prepare(
      "SELECT external_id FROM identities WHERE user_id = ?1 AND provider = 'coinbase'",
    )
      .bind(a.id)
      .all<{ external_id: string }>();
    expect(ids.results.map((r) => r.external_id)).toEqual([p1]);
    // p2's tombstone was not inherited or consumed.
    const limits = await env.DB.prepare('SELECT COUNT(*) AS n FROM limits WHERE user_id = ?1')
      .bind(a.id)
      .first<{ n: number }>();
    expect(limits?.n).toBe(0);
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM person_tombstones WHERE person_id = ?1',
    )
      .bind(p2)
      .first<{ n: number }>();
    expect(left?.n).toBe(1);
  });

  it('re-verifying with the same Coinbase account refreshes the country and region', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    expect(await verifyAs(t, a.headers, person(106, 'US', 'NJ'))).toMatchObject({ country: 'US' });
    expect(await verifyAs(t, a.headers, person(106, 'GB', 'LND'))).toMatchObject({
      status: 'verified',
      country: 'GB',
    });
    const row = await env.DB.prepare(
      'SELECT coinbase_country, coinbase_region FROM users WHERE id = ?1',
    )
      .bind(a.id)
      .first();
    expect(row).toEqual({ coinbase_country: 'GB', coinbase_region: 'LND' });
    const ids = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM identities WHERE user_id = ?1 AND provider = 'coinbase'",
    )
      .bind(a.id)
      .first<{ n: number }>();
    expect(ids?.n).toBe(1);
  });
});

// W7-F1 R9: the bind applies only to an active account, so one racing a suspension or DELETE /me
// changes nothing. The race seam changes the account after every read, just before the bind batch.
describe('the bind races a suspension or a deletion', () => {
  it('nothing is bound to an account suspended or deleted since the read', async () => {
    for (const [status, reason] of [
      ['suspended', 'account_suspended'],
      ['deleted', 'account_unavailable'],
    ] as const) {
      const t = personhoodEnv();
      const a = await account(t);
      const personId = `0x${(status === 'suspended' ? '9a' : '9d').repeat(32)}`;
      const race = raceBefore(t.env, { batchOf: 3 }, () => setStatus(a.id, status));
      const out = await applyVerification(
        t.env,
        a.id,
        personId,
        { country: 'US', region: 'NJ' },
        Date.now(),
      );
      race.restore();
      expect(race.fired()).toBe(true);
      expect(out).toEqual({ status: 'failed', reason });
      expect(await personIdOf(a.id)).toBeNull();
      const identities = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM identities WHERE user_id = ?1 AND provider = 'coinbase'",
      )
        .bind(a.id)
        .first<{ n: number }>();
      expect(identities?.n).toBe(0);
    }
  });
});

describe('person tombstone', () => {
  it('a new account of a deleted person inherits the daily cap state, and the tombstone is consumed', async () => {
    const t = personhoodEnv();
    const p = person(110);
    const pid = await personIdFor(t.env, p.id);
    const effectiveAt = Date.now() + 3_600_000;
    await env.DB.prepare(
      'INSERT INTO person_tombstones (person_id, daily_stake_cap, pending_cap, pending_cap_effective_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
      .bind(pid, 25_000_000, 50_000_000, effectiveAt, Date.now())
      .run();
    const a = await account(t);
    expect((await verifyAs(t, a.headers, p)).status).toBe('verified');
    const limits = await env.DB.prepare(
      'SELECT daily_stake_cap, pending_cap, pending_cap_effective_at FROM limits WHERE user_id = ?1',
    )
      .bind(a.id)
      .first();
    expect(limits).toEqual({
      daily_stake_cap: 25_000_000,
      pending_cap: 50_000_000,
      pending_cap_effective_at: effectiveAt,
    });
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM person_tombstones WHERE person_id = ?1',
    )
      .bind(pid)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('a lower cap the new account already set wins over the inherited one', async () => {
    const t = personhoodEnv();
    const p = person(111);
    await env.DB.prepare(
      'INSERT INTO person_tombstones (person_id, daily_stake_cap, created_at) VALUES (?1, ?2, ?3)',
    )
      .bind(await personIdFor(t.env, p.id), 25_000_000, Date.now())
      .run();
    const a = await account(t);
    await env.DB.prepare('INSERT INTO limits (user_id, daily_stake_cap) VALUES (?1, ?2)')
      .bind(a.id, 10_000_000)
      .run();
    await verifyAs(t, a.headers, p);
    const limits = await env.DB.prepare('SELECT daily_stake_cap FROM limits WHERE user_id = ?1')
      .bind(a.id)
      .first();
    expect(limits).toEqual({ daily_stake_cap: 10_000_000 });
  });

  it("an inherited pending increase applies only when the account's own cap is not lower", async () => {
    const t = personhoodEnv();
    const effectiveAt = Date.now() + 3_600_000;
    const limitsAfter = async (n: number, ownCap: number) => {
      const p = person(n);
      await env.DB.prepare(
        'INSERT INTO person_tombstones (person_id, daily_stake_cap, pending_cap, pending_cap_effective_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
        .bind(await personIdFor(t.env, p.id), 20_000_000, 500_000_000, effectiveAt, Date.now())
        .run();
      const a = await account(t);
      await env.DB.prepare('INSERT INTO limits (user_id, daily_stake_cap) VALUES (?1, ?2)')
        .bind(a.id, ownCap)
        .run();
      expect((await verifyAs(t, a.headers, p)).status).toBe('verified');
      return env.DB.prepare(
        'SELECT daily_stake_cap, pending_cap, pending_cap_effective_at FROM limits WHERE user_id = ?1',
      )
        .bind(a.id)
        .first();
    };
    // The account lowered its cap to 10 later: the tombstone's raise (20 → 500) must not undo it.
    expect(await limitsAfter(113, 10_000_000)).toEqual({
      daily_stake_cap: 10_000_000,
      pending_cap: null,
      pending_cap_effective_at: null,
    });
    // An account cap of 30: the tombstone's 20 wins, and its pending raise keeps its timer.
    expect(await limitsAfter(114, 30_000_000)).toEqual({
      daily_stake_cap: 20_000_000,
      pending_cap: 500_000_000,
      pending_cap_effective_at: effectiveAt,
    });
  });

  it('W7-F1 R2: only a pending increase from the side whose cap is in force survives (B3b)', async () => {
    const t = personhoodEnv();
    const at = Date.now() + 3_600_000;
    type Cap = [number | null, number | null, number | null];
    const limitsAfter = async (n: number, tombstone: Cap, own: Cap) => {
      const p = person(n);
      await env.DB.prepare(
        'INSERT INTO person_tombstones (person_id, daily_stake_cap, pending_cap, pending_cap_effective_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
        .bind(await personIdFor(t.env, p.id), ...tombstone, Date.now())
        .run();
      const a = await account(t);
      await env.DB.prepare(
        'INSERT INTO limits (user_id, daily_stake_cap, pending_cap, pending_cap_effective_at) VALUES (?1, ?2, ?3, ?4)',
      )
        .bind(a.id, ...own)
        .run();
      expect((await verifyAs(t, a.headers, p)).status).toBe('verified');
      return env.DB.prepare(
        'SELECT daily_stake_cap, pending_cap, pending_cap_effective_at FROM limits WHERE user_id = ?1',
      )
        .bind(a.id)
        .first();
    };
    const state = (cap: number, pending: number | null, effectiveAt: number | null) => ({
      daily_stake_cap: cap,
      pending_cap: pending,
      pending_cap_effective_at: effectiveAt,
    });
    // The tombstone's 20 is in force: the account's own raise (30 → 40) is dropped.
    expect(await limitsAfter(120, [20e6, null, null], [30e6, 40e6, at])).toEqual(
      state(20e6, null, null),
    );
    // The account's 10 is in force: its raise survives, the tombstone's is dropped.
    expect(await limitsAfter(121, [20e6, 500e6, at], [10e6, 15e6, at + 5])).toEqual(
      state(10e6, 15e6, at + 5),
    );
    // Equal caps: the lower raise with its own timer; on a tie, the later timer.
    expect(await limitsAfter(122, [20e6, 40e6, at + 9], [20e6, 60e6, at])).toEqual(
      state(20e6, 40e6, at + 9),
    );
    expect(await limitsAfter(123, [20e6, 40e6, at], [20e6, 40e6, at + 9])).toEqual(
      state(20e6, 40e6, at + 9),
    );
  });

  it('no tombstone: no limits row is created', async () => {
    const t = personhoodEnv();
    const a = await account(t);
    await verifyAs(t, a.headers, person(112));
    const limits = await env.DB.prepare('SELECT COUNT(*) AS n FROM limits WHERE user_id = ?1')
      .bind(a.id)
      .first<{ n: number }>();
    expect(limits?.n).toBe(0);
  });
});

/** Every D1 row and KV entry, one string per table or entry (as test/auth/privacy.test.ts). */
async function storedText(): Promise<string> {
  const out: string[] = [];
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  for (const { name } of results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
    out.push(`${name}: ${JSON.stringify(rows.results)}`);
  }
  let cursor: string | undefined;
  do {
    const page = await env.KV.list(cursor ? { cursor } : {});
    for (const k of page.keys) out.push(`kv ${k.name}: ${(await env.KV.get(k.name)) ?? ''}`);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.join('\n').toLowerCase();
}

describe('NFR-8 (Coinbase part)', () => {
  it('no raw Coinbase ID, name, email or address is stored in D1 or KV after every personhood flow', async () => {
    const t = personhoodEnv();
    const people = [
      person(120, 'US', 'NJ'),
      { ...person(121), personal: null },
      person(122, 'GB', 'LND'),
    ];
    const older = await account(t, Date.now() - 86_400_000);
    const newer = await account(t);
    const unverified = await account(t);
    await verifyAs(t, older.headers, people[0] as CoinbasePerson); // verified
    await verifyAs(t, newer.headers, people[0] as CoinbasePerson); // pending merge
    await verifyAs(t, unverified.headers, people[1] as CoinbasePerson); // no personal details
    await verifyAs(t, unverified.headers, people[2] as CoinbasePerson); // person mismatch

    const stored = await storedText();
    for (const p of people) {
      const secrets = [
        p.id,
        p.name,
        p.email,
        ...(p.personal
          ? [
              p.personal.legal_name.last_name,
              p.personal.address.line1,
              p.personal.address.city,
              p.personal.address.postal_code,
            ]
          : []),
      ];
      for (const s of secrets) expect(stored, s).not.toContain(s.toLowerCase());
    }
    // The country and region codes are stored, on the user only.
    expect(stored).toContain('"coinbase_country":"us","coinbase_region":"nj"');
  });
});
