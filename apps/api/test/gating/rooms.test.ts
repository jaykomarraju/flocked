// Spec "API" › Reveal gating: "Room round endpoints, WebSockets and bundles are for members only."
// Every gated route of a (revealed) room round — the round, /verify, the bundle objects, /me, the
// WebSocket and the round-card stub — answers 401 without a session and 404 (exactly as for a round that
// doesn't exist) to a signed-in non-member, and serves members `private, no-store`. The edge cache
// (src/read/cache.ts, off on `local`) is driven with a `staging` env and a fake Cache through
// EDGE_CACHE_DEPS: it stores anonymous public reads only, never a room-round or signed-in response,
// and never answers for a room round. GET /claims?wallet= leaves room rounds out of `claims`, and
// lists the wallet's own room-round payouts in `roomClaims` with only the chain round ID, kind,
// account, amount, proof and claim-open time (O5).
import { env } from 'cloudflare:test';
import {
  ClaimsResponseSchema,
  ErrorEnvelopeSchema,
  RoundDetailResponseSchema,
  RoundMeResponseSchema,
  RoundVerifyResponseSchema,
  RoundsArchiveResponseSchema,
} from '@flocked/shared';
import type { Hex } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { EDGE_CACHE_DEPS, PRIVATE_CACHE_CONTROL } from '../../src/read/cache.js';
import { FIXTURE_IDS, seedFixture } from '../helpers/index.js';
import { BEACON_TIME_MS } from '../settlement/helpers.js';
import { stakesEnv } from '../settlement/stakes-helpers.js';
import {
  ORIGIN,
  at,
  ensureUser,
  freeToWindow,
  get,
  randomWallet,
  seedFree,
  seedStakesRound,
  signIn,
  stakesToWindow,
} from './helpers.js';

const ROOM = FIXTURE_IDS.room;
const UNKNOWN_ROUND = '01K7ZZZZZZZZZZZZZZZZZZZZZZ';

/** A revealed Free room round whose three entrants are all members of the fixture room. */
let roomRound: string;
/** A revealed public (daily) Free round. */
let dailyRound: string;
/** Signed-in headers: a member with an entry, the room's owner (no entry), a non-member. */
let entrant: Record<string, string>;
let owner: Record<string, string>;
let outsider: Record<string, string>;

async function join(userId: string): Promise<void> {
  await ensureUser(userId);
  await env.DB.prepare(
    "INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', 1759000000000)",
  )
    .bind(ROOM, userId)
    .run();
}

beforeAll(async () => {
  await seedFixture(env.DB);
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const room = await seedFree([0, 1, 1], { room: ROOM });
  for (const e of room.entries) await join(e.userId);
  await (await freeToWindow(room.roundId)).reveal();
  roomRound = room.roundId;

  const daily = await seedFree([0, 1, 1]);
  await (await freeToWindow(daily.roundId)).reveal();
  dailyRound = daily.roundId;

  entrant = await signIn(room.entries[0]?.userId as string);
  owner = await signIn(FIXTURE_IDS.user);
  outsider = await signIn(FIXTURE_IDS.otherUser);
});
afterAll(() => {
  vi.restoreAllMocks();
});

const local = () => at(BEACON_TIME_MS + 10_000);

/**
 * Every gated route of a round, with what a member gets (after the gate, the WebSocket answers a plain
 * GET 400; test/ws/ upgrades members). The round card is a PNG, private for a room round (W10-A).
 */
const ROUTES = (id: string) =>
  [
    [`/rounds/${id}`, 200],
    [`/rounds/${id}/verify`, 200],
    [`/rounds/${id}/bundles/free/manifest.json`, 200],
    [`/rounds/${id}/bundles/free/chunk-0000.json`, 200],
    [`/rounds/${id}/me`, 200],
    [`/rounds/${id}/ws`, 400],
    [`/rounds/${id}/card/og.png`, 200],
  ] as const;

describe('room rounds are members-only on every gated route', () => {
  it.each(ROUTES('ROOM').map(([path, status]) => [path, status] as const))(
    '%s: anonymous 401, signed-in non-member 404 (as for no round), member %i',
    async (template, memberStatus) => {
      const path = template.replace('ROOM', roomRound);
      const anon = await get(local(), path);
      expect(anon.status).toBe(401);
      expect(ErrorEnvelopeSchema.parse(anon.json).error.code).toBe('unauthorized');

      const nonMember = await get(local(), path, outsider);
      const none = await get(local(), template.replace('ROOM', UNKNOWN_ROUND), outsider);
      expect(nonMember.status).toBe(404);
      expect(nonMember.json).toEqual(none.json);
      expect(ErrorEnvelopeSchema.parse(nonMember.json).error.code).toBe('not_found');

      for (const member of [entrant, owner]) {
        const a = await get(local(), path, member);
        expect(a.status).toBe(memberStatus);
        if (a.status === 200) expect(a.headers.get('Cache-Control')).toBe(PRIVATE_CACHE_CONTROL);
      }
    },
  );

  it('a member gets the room round’s data: the round, its settlement, its bundle, their entry', async () => {
    const round = RoundDetailResponseSchema.parse(
      (await get(local(), `/rounds/${roomRound}`, entrant)).json,
    );
    expect(round.round).toMatchObject({ kind: 'room', roomId: ROOM });
    expect(round.round.modes.free?.settlement?.winningOption).toBe(0);
    const verify = RoundVerifyResponseSchema.parse(
      (await get(local(), `/rounds/${roomRound}/verify`, entrant)).json,
    );
    expect(verify.modes.free?.chunkUrls.length).toBeGreaterThan(0);
    const me = RoundMeResponseSchema.parse(
      (await get(local(), `/rounds/${roomRound}/me`, entrant)).json,
    );
    expect(me.modes.free?.result).toBe('win');
    const ownerMe = RoundMeResponseSchema.parse(
      (await get(local(), `/rounds/${roomRound}/me`, owner)).json,
    );
    expect(ownerMe.modes).toEqual({});
  });

  it('a room round is never listed: not in the archive, not on /rounds/today, for anyone', async () => {
    for (const h of [{}, entrant, outsider]) {
      const archive = RoundsArchiveResponseSchema.parse(
        (await get(local(), '/rounds?limit=100', h)).json,
      );
      expect(archive.rounds.map((r) => r.id)).toContain(dailyRound);
      expect(archive.rounds.map((r) => r.id)).not.toContain(roomRound);
      const today = (await get(local(), '/rounds/today', h)).json as {
        round: { id: string } | null;
      };
      expect(today.round?.id).not.toBe(roomRound);
    }
  });

  it('a public round’s gated routes answer anyone, public responses cacheable', async () => {
    for (const [template, memberStatus] of ROUTES('DAILY')) {
      const path = template.replace('DAILY', dailyRound);
      if (path.endsWith('/me')) continue;
      for (const h of [{}, outsider]) {
        const a = await get(local(), path, h);
        expect(a.status, path).toBe(memberStatus);
        if (a.status === 200) expect(a.headers.get('Cache-Control')).toMatch(/^public, max-age=/);
      }
    }
  });
});

// The edge cache --------------------------------------------------------------------------------

/** A Cache that records every match and put; `store` is keyed by URL. */
class FakeCache {
  readonly store = new Map<string, Response>();
  readonly puts: string[] = [];
  readonly matches: string[] = [];
  match(req: Request): Promise<Response | undefined> {
    this.matches.push(req.url);
    return Promise.resolve(this.store.get(req.url)?.clone());
  }
  put(req: Request, res: Response): Promise<void> {
    this.puts.push(req.url);
    this.store.set(req.url, res);
    return Promise.resolve();
  }
}

/** A cached stand-in body, to tell a cache hit from a fresh read. */
const marker = () =>
  new Response(JSON.stringify({ cached: true }), {
    headers: { 'content-type': 'application/json', 'Cache-Control': 'public, max-age=5' },
  });

describe('the edge cache stores anonymous public reads only', () => {
  let cache: FakeCache;
  const saved = EDGE_CACHE_DEPS.cache;
  const staging = (): Env => ({ ...env, ENVIRONMENT: 'staging' });
  const url = (path: string) => `${ORIGIN}/api/v1${path}`;

  beforeAll(() => {
    cache = new FakeCache();
    EDGE_CACHE_DEPS.cache = () => cache as unknown as Cache;
  });
  afterEach(() => {
    cache.store.clear();
    cache.puts.length = 0;
    cache.matches.length = 0;
  });
  afterAll(() => {
    EDGE_CACHE_DEPS.cache = saved;
  });

  it.each([
    ['/rounds/today'],
    ['/rounds?limit=100'],
    ['/rounds/DAILY'],
    ['/rounds/DAILY/verify'],
    ['/claims?wallet=WALLET'],
  ])(
    'anonymous %s: stored once, then answered from the cache; signed in: never read or stored',
    async (template) => {
      const path = template.replace('DAILY', dailyRound).replace('WALLET', randomWallet());
      const first = await get(staging(), path);
      expect(first.status).toBe(200);
      expect(first.headers.get('Cache-Control')).toBe('public, max-age=5');
      expect(cache.puts).toEqual([url(path)]);
      // The next anonymous request is the cache's answer.
      cache.store.set(url(path), marker());
      expect((await get(staging(), path)).json).toEqual({ cached: true });
      // A signed-in request never sees the cached copy and never stores its own.
      const puts = cache.puts.length;
      const matches = cache.matches.length;
      const signedIn = await get(staging(), path, entrant);
      expect(signedIn.status).toBe(200);
      expect(signedIn.json).not.toEqual({ cached: true });
      expect(cache.puts).toHaveLength(puts);
      expect(cache.matches).toHaveLength(matches);
    },
  );

  it.each([
    ['/rounds/ROOM'],
    ['/rounds/ROOM/verify'],
    ['/rounds/ROOM/bundles/free/manifest.json'],
    ['/rounds/ROOM/me'],
  ])(
    'room round %s: never stored, and never answered from the cache, for anyone',
    async (template) => {
      const path = template.replace('ROOM', roomRound);
      // Even an entry in the cache for the URL (none can get there) answers nobody.
      cache.store.set(url(path), marker());
      const anon = await get(staging(), path);
      expect(anon.status).toBe(401);
      const nonMember = await get(staging(), path, outsider);
      expect(nonMember.status).toBe(404);
      const member = await get(staging(), path, entrant);
      expect(member.status).toBe(200);
      expect(member.json).not.toEqual({ cached: true });
      expect(member.headers.get('Cache-Control')).toBe(PRIVATE_CACHE_CONTROL);
      expect(cache.puts).toEqual([]);
      expect(cache.matches).toEqual([]);
    },
  );

  it('signed-in-only reads (/claims, /rounds/:id/me) are private and never stored', async () => {
    for (const path of ['/claims', `/rounds/${dailyRound}/me`]) {
      const a = await get(staging(), path, entrant);
      expect(a.status, path).toBe(200);
      expect(a.headers.get('Cache-Control')).toBe(PRIVATE_CACHE_CONTROL);
    }
    expect(cache.puts).toEqual([]);
  });

  it('on the local environment the cache is never touched', async () => {
    for (const path of ['/rounds/today', `/rounds/${dailyRound}`, `/rounds/${dailyRound}/verify`]) {
      expect((await get(local(), path)).status).toBe(200);
    }
    expect(cache.puts).toEqual([]);
    expect(cache.matches).toEqual([]);
  });
});

// GET /claims?wallet= ---------------------------------------------------------------------------

describe('GET /claims?wallet= leaves room rounds out of `claims`', () => {
  it('a wallet’s revealed win in a room round is listed for its signed-in owner only; its daily win is public', async () => {
    const wallet = randomWallet() as Hex;
    // The same wallet wins (option 0, the minority) in a daily round and in a room round.
    const daily = await seedStakesRound([0, 0, 1, 1, 1], { players: [wallet] });
    const room = await seedStakesRound([0, 0, 1, 1, 1], { room: ROOM, players: [wallet] });
    for (const r of [daily, room]) {
      const w = await stakesToWindow(r);
      await w.reveal();
    }
    const holder = room.entries[0]?.userId as string;
    await join(holder);

    // The room round's claim is its owner's, signed in (and its proof comes with it).
    const mine = ClaimsResponseSchema.parse(
      (await get(local(), '/claims', await signIn(holder))).json,
    );
    expect(mine.claims.map((c) => c.roundId)).toEqual([room.roundId]);
    expect(mine.claims[0]?.proof?.length).toBeGreaterThan(0);
    expect(mine.roomClaims).toBeUndefined();
    const owned = mine.claims[0];
    if (!owned) throw new Error('no room claim');

    for (const h of [{}, outsider, entrant]) {
      const answer = await get(local(), `/claims?wallet=${wallet}`, h);
      const byWallet = ClaimsResponseSchema.parse(answer.json);
      expect(byWallet.claims.map((c) => c.roundId)).toEqual([daily.roundId]);
      expect(byWallet.claims[0]).toMatchObject({ kind: 'win', account: wallet, userId: null });
      // O5: the wallet's own room-round payout, with only what claiming needs (exact keys).
      expect((answer.json as { roomClaims: unknown }).roomClaims).toEqual([
        {
          chainRoundId: owned.chainRoundId,
          kind: 'win',
          account: wallet,
          amount: owned.amount,
          proof: owned.proof,
          claimsOpenAt: owned.claimsOpenAt,
        },
      ]);
      // Nothing names the room round, its room, its question or another member.
      const text = new TextDecoder().decode(answer.bytes);
      for (const secret of [room.roundId, ROOM, ...room.entries.slice(1).map((e) => e.wallet)]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
