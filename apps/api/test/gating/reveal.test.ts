// PIPE-1 (API half) and AC-2 (API part), spec "API" › Reveal gating: no endpoint exposes per-option
// data for a mode until that mode's `revealed_at` is set. Every GET route of the pinned ENDPOINTS
// table (plus the bundle objects and `/claims?wallet=`) is walked anonymously and as two signed-in
// entrants (a winner and one whose pick is VOID), for a Free round and a Stakes round, at each stage:
//   1. open, entries in;
//   2. closed, before the beacon;
//   3. the dangerous window: settlement has written its per-option data to D1 and R2 but
//      `revealed_at` is still null (the real pipelines, stopped there: test/gating/helpers.ts);
//   4. revealed (and, for Stakes, final).
// Before the reveal a recursive scan of every JSON body finds no per-option data and no bundle object
// is served; after it the data is there, so the scan can't pass vacuously. Every 200 body is checked
// against its endpoint's response schema.
import { env } from 'cloudflare:test';
import {
  ClaimsResponseSchema,
  ErrorEnvelopeSchema,
  RoundDetailResponseSchema,
  RoundMeResponseSchema,
  RoundVerifyResponseSchema,
  RoundsArchiveResponseSchema,
  type EndpointDef,
  type Mode,
} from '@flocked/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { FIXTURE_IDS, seedFixture } from '../helpers/index.js';
import { BEACON_TIME_MS } from '../settlement/helpers.js';
import { stakesEnv, type SeededStakes } from '../settlement/stakes-helpers.js';
import {
  GET_ENDPOINTS,
  at,
  close,
  concretePath,
  freeToWindow,
  get,
  perOptionData,
  randomWallet,
  reopen,
  roundTimes,
  seedFree,
  seedStakesRound,
  signIn,
  stakesToWindow,
  type Answer,
  type FreeWindow,
  type StakesWindow,
} from './helpers.js';

beforeAll(async () => {
  await seedFixture(env.DB);
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

const MODES: Mode[] = ['free', 'stakes'];

interface Subject {
  roundId: string;
  mode: Mode;
  /** The signed-in entrant (an entry in `mode`, on the winning side). */
  entrant: string;
  headers: Record<string, string>;
  /** A second signed-in entrant whose pick is a VOID. */
  voider: Record<string, string>;
  /** The entrant's Stakes wallet, or a wallet with no entries. */
  wallet: string;
  /** The wallets `/claims?wallet=` is asked about: the entrant's, then the voider's. */
  wallets: string[];
}

interface Probe {
  key: string;
  path: string;
  ep: EndpointDef | null;
  headers: Record<string, string>;
}

/**
 * Every GET route of ENDPOINTS, anonymous and as both entrants, plus `/claims?wallet=` for their
 * wallets and the round's four possible bundle objects.
 */
function probes(s: Subject): Probe[] {
  const ids = { round: s.roundId, room: FIXTURE_IDS.room, user: s.entrant };
  const out: Probe[] = [];
  const who = [
    ['anon', {}],
    ['entrant', s.headers],
    ['voider', s.voider],
  ] as const;
  for (const ep of GET_ENDPOINTS) {
    const paths = [concretePath(ep.path, ids)];
    if (ep.path === '/claims') paths.push(...s.wallets.map((w) => `/claims?wallet=${w}`));
    if (ep.path === '/rounds') paths[0] = '/rounds?limit=100';
    for (const path of paths) {
      for (const [w, headers] of who) out.push({ key: `${w} GET ${path}`, path, ep, headers });
    }
  }
  for (const mode of MODES) {
    for (const file of ['manifest.json', 'chunk-0000.json']) {
      const path = `/rounds/${s.roundId}/bundles/${mode}/${file}`;
      for (const [w, headers] of who)
        out.push({ key: `${w} GET ${path}`, path, ep: null, headers });
    }
  }
  return out;
}

/**
 * The part of a body about the round under test: other rounds in the file (revealed ones included)
 * show up in the archive, on /rounds/today and in /claims, and are not this walk's concern.
 */
function focus(path: string, json: unknown, roundId: string): unknown {
  if (json === null || typeof json !== 'object') return json;
  const b = json as Record<string, unknown>;
  if (path.startsWith('/rounds?') && Array.isArray(b.rounds)) {
    return { ...b, rounds: (b.rounds as { id: string }[]).filter((r) => r.id === roundId) };
  }
  if (path.startsWith('/claims') && Array.isArray(b.claims)) {
    return {
      ...b,
      claims: (b.claims as { roundId: string }[]).filter((c) => c.roundId === roundId),
    };
  }
  if (path === '/rounds/today' && 'round' in b) {
    return (b.round as { id: string } | null)?.id === roundId ? b : { ...b, round: null };
  }
  return json;
}

interface Walk {
  answers: Map<string, Answer>;
  /** Per-option data found, by probe. */
  leaks: string[];
  /** Bundle objects served (status 200). */
  bundlesServed: string[];
}

/** Walks every probe with `e`; checks statuses and 200 bodies against their schemas. */
async function walk(s: Subject, e: Env): Promise<Walk> {
  const answers = new Map<string, Answer>();
  const leaks: string[] = [];
  const bundlesServed: string[] = [];
  for (const p of probes(s)) {
    const a = await get(e, p.path, p.headers);
    answers.set(p.key, a);
    // Nothing fails: an unimplemented route answers 501, which leaks nothing.
    expect(a.status < 500 || a.status === 501, `${p.key} answered ${a.status}`).toBe(true);
    if (a.status !== 200) {
      if (a.json !== null) ErrorEnvelopeSchema.parse(a.json);
    } else if (p.ep && (p.ep.responseType ?? 'json') === 'json') {
      const parsed = p.ep.response.safeParse(a.json);
      expect(parsed.success, `${p.key}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
    if (p.ep === null && a.status === 200) bundlesServed.push(p.key);
    for (const l of perOptionData(focus(p.path, a.json, s.roundId))) leaks.push(`${p.key}: ${l}`);
  }
  return { answers, leaks, bundlesServed };
}

function body<T>(w: Walk, key: string, schema: { parse(v: unknown): T }): T {
  const a = w.answers.get(key);
  if (!a) throw new Error(`no answer for ${key}`);
  expect(a.status, key).toBe(200);
  return schema.parse(a.json);
}

/** Before the reveal: no per-option data anywhere and no bundle object, whoever asks. */
function expectSealed(w: Walk, s: Subject): void {
  expect(w.leaks).toEqual([]);
  expect(w.bundlesServed).toEqual([]);
  expectReached(w, s);
}

/**
 * The walk reached the round: every read that carries the round answered 200 (so a clean scan
 * means a clean body, not an error), every GET route was asked, and the round's other reads are
 * gated or not implemented yet.
 */
function expectReached(w: Walk, s: Subject): void {
  const id = s.roundId;
  const ok = (who: string, path: string) =>
    expect(w.answers.get(`${who} GET ${path}`)?.status, `${who} GET ${path}`).toBe(200);
  for (const who of ['anon', 'entrant', 'voider']) {
    for (const path of [
      '/rounds/today',
      '/rounds?limit=100',
      `/rounds/${id}`,
      `/rounds/${id}/verify`,
      ...s.wallets.map((wallet) => `/claims?wallet=${wallet}`),
    ]) {
      ok(who, path);
    }
  }
  for (const path of ['/me', `/rounds/${id}/me`, '/claims']) {
    ok('entrant', path);
    ok('voider', path);
    expect(w.answers.get(`anon GET ${path}`)?.status, `anon GET ${path}`).toBe(401);
  }
  // Every GET route of the table, three ways, plus the `?wallet=` asks and four bundle objects.
  expect(w.answers.size).toBe(3 * (GET_ENDPOINTS.length + s.wallets.length + 4));
}

/** After the reveal: the per-option data is served on every read that carries it. */
function expectRevealed(w: Walk, s: Subject, winner: 0 | 1): void {
  expectReached(w, s);
  const round = body(w, `anon GET /rounds/${s.roundId}`, RoundDetailResponseSchema).round;
  const m = round.modes[s.mode];
  expect(m?.revealedAt).not.toBeNull();
  expect(m?.settlement).toMatchObject({ outcome: 'settled', winningOption: winner });
  expect(m?.settlement?.tally).toHaveLength(2);

  const archive = body(w, 'anon GET /rounds?limit=100', RoundsArchiveResponseSchema);
  const item = archive.rounds.find((r) => r.id === s.roundId);
  expect(item?.modes[s.mode]).toMatchObject({ winningOption: winner });
  expect(item?.modes[s.mode]?.tally).not.toBeNull();

  const me = body(w, `entrant GET /rounds/${s.roundId}/me`, RoundMeResponseSchema);
  const mine = me.modes[s.mode];
  expect(mine?.entry).toMatchObject({ optionIndex: winner, valid: true, voidReason: null });
  expect(mine?.result).toBe('win');
  expect(mine?.payouts.map((p) => p.kind)).toEqual(['win']);
  const voided = body(w, `voider GET /rounds/${s.roundId}/me`, RoundMeResponseSchema).modes[s.mode];
  expect(voided?.entry).toMatchObject({
    optionIndex: null,
    valid: false,
    voidReason: 'bad_option',
  });
  expect(voided?.result).toBe('void');
  expect(voided?.payouts.map((p) => p.kind)).toEqual(['void_refund']);

  const verify = body(w, `anon GET /rounds/${s.roundId}/verify`, RoundVerifyResponseSchema);
  expect(Object.keys(verify.modes)).toEqual([s.mode]);
  expect(verify.modes[s.mode]?.chunkUrls.length).toBeGreaterThan(0);

  const served = w.bundlesServed.map((k) => k.replace(/^\w+ /, ''));
  expect(new Set(served)).toEqual(
    new Set([
      `GET /rounds/${s.roundId}/bundles/${s.mode}/manifest.json`,
      `GET /rounds/${s.roundId}/bundles/${s.mode}/chunk-0000.json`,
    ]),
  );
  // The scan sees all of it.
  expect(w.leaks.length).toBeGreaterThan(0);
}

describe('PIPE-1 (API half), AC-2 (API part): a Free round, every GET route, before and after the reveal', () => {
  // Option 0 is the minority; the entrant (entry 0) picked it, the voider's pick (entry 3) is VOID.
  let s: Subject;
  let times: { opensAt: number; closesAt: number };
  let window: FreeWindow;
  let meBefore: unknown;

  beforeAll(async () => {
    const r = await seedFree([0, 1, 1, 'void']);
    const entrant = r.entries[0]?.userId as string;
    const wallet = randomWallet();
    s = {
      roundId: r.roundId,
      mode: 'free',
      entrant,
      headers: await signIn(entrant),
      voider: await signIn(r.entries[3]?.userId as string),
      wallet,
      wallets: [wallet],
    };
    times = await roundTimes(r.roundId);
  });

  it('open, entries in: nothing per option on any route; /rounds/today serves the round', async () => {
    await reopen(s.roundId);
    const w = await walk(s, at(times.closesAt - 60_000));
    expectSealed(w, s);
    const today = w.answers.get('anon GET /rounds/today')?.json as { round: { id: string } };
    expect(today.round.id).toBe(s.roundId);
    const me = body(w, `entrant GET /rounds/${s.roundId}/me`, RoundMeResponseSchema);
    expect(me.modes.free?.entry.optionIndex).toBeNull();
  });

  it('closed, before the beacon: nothing per option on any route', async () => {
    await close(s.roundId);
    const w = await walk(s, at(times.closesAt + 1_000));
    expectSealed(w, s);
    meBefore = w.answers.get('entrant GET /me')?.json;
  });

  it('settlement written (record, outcomes, payouts, bundle) but revealed_at null: nothing per option on any route, no bundle served', async () => {
    window = await freeToWindow(s.roundId);
    // The dangerous window is real: D1 and R2 hold the per-option data.
    const entry = await env.DB.prepare('SELECT option_index, valid FROM entries WHERE id = ?1')
      .bind(window.result.entries[0]?.entryId ?? '')
      .first();
    expect(entry).toEqual({ option_index: 0, valid: 1 });
    const rec = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM settlements WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(s.roundId)
      .first<{ n: number }>();
    expect(rec?.n).toBe(1);
    const payouts = await env.DB.prepare('SELECT kind FROM payouts WHERE round_id = ?1')
      .bind(s.roundId)
      .all<{ kind: string }>();
    expect(payouts.results.map((p) => p.kind)).toContain('win');
    expect(await env.BUCKET.head(`bundles/${s.roundId}/free/manifest.json`)).not.toBeNull();

    const w = await walk(s, at(BEACON_TIME_MS + 5_000));
    expectSealed(w, s);
  });

  // A winner's balance moving before the reveal tells them their side won. applyFree credits the
  // ledger (step 3) before it sets `revealed_at` (step 4), and GET /me reads the balance as is, so in
  // the window the winner's `balances.global` already includes the win. Outside src/read (the fix
  // belongs to src/settlement/apply/free.ts or the balance read); `it.fails` until it's fixed.
  it.fails(
    'KNOWN GAP (reported): a Free winner’s GET /me balance already includes the win before revealed_at',
    async () => {
      const a = await get(at(BEACON_TIME_MS + 5_000), '/me', s.headers);
      const before = meBefore as { balances?: unknown } | undefined;
      const after = a.json as { balances?: unknown } | null;
      // Nothing to compare would pass, which `it.fails` reports: this fails only on the balances.
      if (!before?.balances || !after?.balances) return;
      expect(after.balances).toEqual(before.balances);
    },
  );

  it('revealed: the per-option data is on every read that carries it, and the bundle is served', async () => {
    await window.reveal();
    const w = await walk(s, at(BEACON_TIME_MS + 6_000));
    expectRevealed(w, s, 0);
  });
});

describe('PIPE-1 (API half), AC-2 (API part): a Stakes round, every GET route, before and after the reveal', () => {
  // Option 0 is the minority (2 against 3); the entrant (entry 0) picked it, the voider's pick
  // (entry 5) is VOID.
  let s: Subject;
  let times: { opensAt: number; closesAt: number };
  let window: StakesWindow;
  let stakesRound: SeededStakes;

  beforeAll(async () => {
    const r = await seedStakesRound([0, 0, 1, 1, 1, 'void']);
    const first = r.entries[0];
    const voider = r.entries[5];
    if (!first?.userId || !voider?.userId) throw new Error('no entrants');
    s = {
      roundId: r.roundId,
      mode: 'stakes',
      entrant: first.userId,
      headers: await signIn(first.userId),
      voider: await signIn(voider.userId),
      wallet: first.wallet,
      wallets: [first.wallet, voider.wallet],
    };
    times = await roundTimes(r.roundId);
    stakesRound = r;
  });

  it('open, entries in: nothing per option on any route; /rounds/today serves the round', async () => {
    await reopen(s.roundId);
    const w = await walk(s, at(times.closesAt - 60_000));
    expectSealed(w, s);
    const today = w.answers.get('anon GET /rounds/today')?.json as { round: { id: string } };
    expect(today.round.id).toBe(s.roundId);
  });

  it('closed, before the beacon: nothing per option on any route', async () => {
    await close(s.roundId);
    expectSealed(await walk(s, at(times.closesAt + 1_000)), s);
  });

  it('applyStakes wrote the record, outcomes and bundle and propose is mined, OutcomeProposed not yet indexed (revealed_at null): nothing per option on any route, no bundle served', async () => {
    window = await stakesToWindow(stakesRound);
    const entry = await env.DB.prepare('SELECT option_index, valid FROM entries WHERE id = ?1')
      .bind(stakesRound.entries[0]?.id ?? '')
      .first();
    expect(entry).toEqual({ option_index: 0, valid: 1 });
    const rec = await env.DB.prepare(
      "SELECT outcome, tally_json FROM settlements WHERE round_id = ?1 AND mode = 'stakes'",
    )
      .bind(s.roundId)
      .first<{ outcome: string; tally_json: string }>();
    expect(rec?.outcome).toBe('settled');
    expect(await env.BUCKET.head(`bundles/${s.roundId}/stakes/manifest.json`)).not.toBeNull();

    const w = await walk(s, at(BEACON_TIME_MS + 5_000));
    expectSealed(w, s);
  });

  it('revealed (OutcomeProposed indexed): the per-option data, claims and proofs are served', async () => {
    await window.reveal();
    const w = await walk(s, at(BEACON_TIME_MS + 6_000));
    expectRevealed(w, s, 0);
    const mine = body(w, `entrant GET /rounds/${s.roundId}/me`, RoundMeResponseSchema).modes.stakes;
    expect(mine?.payouts[0]?.proof?.length).toBeGreaterThan(0);
    const voidWallet = s.wallets[1] as string;
    for (const [key, kind, account, userId] of [
      ['entrant GET /claims', 'win', s.wallet, s.entrant],
      [`anon GET /claims?wallet=${s.wallet}`, 'win', s.wallet, null],
      ['voider GET /claims', 'void_refund', voidWallet, undefined],
      [`anon GET /claims?wallet=${voidWallet}`, 'void_refund', voidWallet, null],
    ] as const) {
      const claims = body(w, key, ClaimsResponseSchema).claims.filter(
        (c) => c.roundId === s.roundId,
      );
      expect(claims, key).toHaveLength(1);
      expect(claims[0]).toMatchObject({ kind, account });
      if (userId !== undefined) expect(claims[0]?.userId).toBe(userId);
      expect(claims[0]?.proof?.length).toBeGreaterThan(0);
    }
  });

  it('final (RoundFinalized indexed): still served, with the payouts', async () => {
    await window.finalize();
    const w = await walk(s, at(BEACON_TIME_MS + 3 * 3_600_000));
    expectRevealed(w, s, 0);
    const round = body(w, `anon GET /rounds/${s.roundId}`, RoundDetailResponseSchema).round;
    expect(round.modes.stakes?.status).toBe('settled');
  });
});
