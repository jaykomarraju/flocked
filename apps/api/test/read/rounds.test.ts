// GET /rounds/today and GET /rounds/:id (spec "API"; W6-D): the open daily round with its question,
// times, beacon, live counts and locked config, the previous round while it settles, the first-visit
// daily grant (W3-Z / W4-Z carry-over), and a Free round's revealed settlement from the real
// settlement. Stakes rounds are in stakes.test.ts (the seeders' daily close times would collide in
// one file); reveal gating is test/gating's.
import { env } from 'cloudflare:test';
import {
  RoundDetailResponseSchema,
  RoundsTodayResponseSchema,
  dailyClosesAt,
  dailyOpensAt,
  newUlid,
  roundKey,
  type RoundView,
} from '@flocked/shared';
import type { Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockedRound } from '../../src/do/types.js';
import type { Env } from '../../src/env.js';
import {
  escrowConfigOf,
  freeLockItem,
  type QuestionRow,
  type RoundRow,
} from '../../src/scheduler/lock.js';
import { beaconRoundAtOrAfter } from '../helpers/index.js';
import { sealedPick, useTestSigner } from '../round-do/helpers.js';
import { BEACON_TIME_MS, atBeaconPlus, harness, seedPicks } from '../settlement/helpers.js';
import { FAKE_ANCHOR } from '../anchor-do/fake-chain.js';
import { index } from '../settlement/stakes-helpers.js';
import {
  OPTIONS,
  insertQuestion,
  insertRound,
  insertUser,
  linkIdentity,
  lockedConfig,
  postEntry,
  questionFor,
  request,
  setClock,
  type InsertedRound,
} from './helpers.js';

const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;
const GAME_DAY = '2026-10-20';
const OPENS = dailyOpensAt(GAME_DAY) * 1000;
const CLOSES = dailyClosesAt(GAME_DAY) * 1000;
/** Two hours into the open daily round. */
const T = OPENS + 2 * HOUR;
const PAYOUT = '0x00000000000000000000000000000000a11ce000';
const TREASURY = '0x000000000000000000000000000000000000beef';

let author: string;
let today: InsertedRound;
let previous: InsertedRound;
let older: InsertedRound;

async function roundRow(id: string): Promise<RoundRow> {
  const row = await env.DB.prepare(
    'SELECT id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json FROM rounds WHERE id = ?1',
  )
    .bind(id)
    .first<RoundRow>();
  if (!row) throw new Error(`no round ${id}`);
  return row;
}

async function questionRow(id: string): Promise<QuestionRow> {
  const row = await env.DB.prepare(
    'SELECT id, author_user_id, prompt, options_json, status FROM questions WHERE id = ?1',
  )
    .bind(id)
    .first<QuestionRow>();
  if (!row) throw new Error(`no question ${id}`);
  return row;
}

async function getToday(userId?: string, e?: Env) {
  const res = await request('/rounds/today', {
    ...(userId ? { userId } : {}),
    ...(e ? { env: e } : {}),
  });
  expect(res.status).toBe(200);
  return RoundsTodayResponseSchema.parse(await res.json());
}

async function getRound(id: string): Promise<RoundView> {
  const res = await request(`/rounds/${id}`);
  expect(res.status).toBe(200);
  return RoundDetailResponseSchema.parse(await res.json()).round;
}

beforeAll(async () => {
  useTestSigner();
  setClock(T);
  author = await insertUser({
    handle: 'flock_author',
    displayName: 'Flock Author',
    avatarUrl: 'https://img.flocked.test/a.png',
    // As PATCH /me stores it; the lock resolved it as the Stakes creator and froze it (O4).
    prefs: { creator_payout_wallet: PAYOUT },
  });
  const beaconRound = beaconRoundAtOrAfter(CLOSES / 1000 + 120);
  today = await insertRound({
    questionId: await insertQuestion({ authorId: author, prompt: 'Cats or dogs?' }),
    opensAt: OPENS,
    closesAt: CLOSES,
    beaconRound,
    status: 'open',
    config: lockedConfig(['free', 'stakes'], {
      creator: PAYOUT,
      awardRecipient: author,
      payoutAddress: PAYOUT,
    }),
    modes: { free: {}, stakes: { chainRoundId: '42' } },
  });
  // The previous daily round (a house question, the treasury as creator), still settling.
  previous = await insertRound({
    opensAt: OPENS - DAY_MS,
    closesAt: OPENS,
    beaconRound: beaconRoundAtOrAfter(OPENS / 1000 + 120),
    config: lockedConfig(['free', 'stakes'], { creator: TREASURY }),
    modes: { free: { status: 'revealing' }, stakes: { status: 'revealing', chainRoundId: '41' } },
  });
  // An authored round whose creator is the treasury, not the author's payout wallet.
  older = await insertRound({
    questionId: await insertQuestion({ authorId: author }),
    opensAt: OPENS - 2 * DAY_MS,
    closesAt: OPENS - DAY_MS,
    config: lockedConfig(['stakes'], { creator: TREASURY }),
    modes: { stakes: { status: 'refunded', refundReason: 1, chainRoundId: '40' } },
  });
  const locked: LockedRound = {
    roundId: today.id,
    kind: 'daily',
    roomId: null,
    questionId: today.questionId,
    opensAt: OPENS,
    closesAt: CLOSES,
    beaconRound,
    beaconTimeSec: Number(env.DRAND_GENESIS) + (beaconRound - 1) * Number(env.DRAND_PERIOD),
    config: today.config,
    modes: ['free', 'stakes'],
    chainRoundId: '42',
  };
  await env.ROUND.get(env.ROUND.idFromName(today.id)).init(locked);
});

beforeEach(() => {
  setClock(T);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /rounds/today', () => {
  it('is null in a schedule gap, with the round that just closed as previousRoundId while it settles', async () => {
    setClock(Date.UTC(2026, 5, 1, 12));
    expect(await getToday()).toEqual({ round: null, previousRoundId: null, crowdHint: null });
    // The day after today's round has no round: a gap, and today's round is still pending.
    setClock(CLOSES + HOUR);
    expect(await getToday()).toEqual({
      round: null,
      previousRoundId: today.id,
      crowdHint: null,
    });
  });

  it('serves the open daily round: question, author, times, beacon, the RoundDO’s counts, the locked config', async () => {
    const stub = env.ROUND.get(env.ROUND.idFromName(today.id));
    const players = [await insertUser(), await insertUser()];
    for (const [i, u] of players.entries()) {
      const res = await postEntry(
        u,
        today.id,
        ['25', '40'][i] as string,
        await sealedPick({ roundId: today.id, beaconRound: today.beaconRound }),
      );
      expect(res.status).toBe(201);
    }
    // A mirrored `Entered`: the RoundDO counts it; D1 has no Stakes entry row for it.
    await stub.ingestStakesEntry({
      roundId: today.id,
      chainRoundId: '42',
      player: `0x${'77'.repeat(20)}`,
      personTag: `0x${'01'.repeat(32)}`,
      ticketHash: `0x${'02'.repeat(32)}`,
      stake: '5000000',
      commitment: `0x${'03'.repeat(32)}`,
      userId: null,
      txHash: `0x${'04'.repeat(32)}`,
      blockNumber: 10,
      logIndex: 0,
      blockTimestampSec: T / 1000,
    });

    const { round, previousRoundId } = await getToday();
    if (!round) throw new Error('no round');
    expect(previousRoundId).toBe(previous.id);
    const beaconTime =
      Number(env.DRAND_GENESIS) + (today.beaconRound - 1) * Number(env.DRAND_PERIOD);
    expect(round).toMatchObject({
      id: today.id,
      kind: 'daily',
      roomId: null,
      gameDay: GAME_DAY,
      status: 'open',
      question: {
        id: today.questionId,
        prompt: 'Cats or dogs?',
        options: OPTIONS,
        category: 'food',
        author: {
          id: author,
          handle: 'flock_author',
          displayName: 'Flock Author',
          avatarUrl: 'https://img.flocked.test/a.png',
        },
      },
      opensAt: OPENS / 1000,
      closesAt: CLOSES / 1000,
      beaconRound: today.beaconRound,
      beaconTime,
      lockedAt: OPENS - 6 * HOUR,
    });
    // The RoundDO accepted that beacon time for that round on the pinned chain.
    expect((await stub.getState()).beaconTimeSec).toBe(beaconTime);

    expect(round.modes).toEqual({
      free: {
        status: 'pending',
        entrantCount: 2,
        pool: '65',
        chainRoundId: null,
        revealedAt: null,
        claimsOpenAt: null,
        finalAt: null,
        refundReason: null,
        settlement: null,
      },
      stakes: {
        status: 'pending',
        entrantCount: 1,
        pool: '5000000',
        chainRoundId: '42',
        revealedAt: null,
        claimsOpenAt: null,
        finalAt: null,
        refundReason: null,
        settlement: null,
      },
    });
    const d1 = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM entries WHERE round_id = ?1 AND mode = 'stakes'",
    )
      .bind(today.id)
      .first<{ n: number }>();
    expect(d1?.n).toBe(0);

    // The config: Free with the lock leaf's config hash; Stakes field for field the RoundConfig the
    // scheduler passes to createRound, with the author's handle and payout wallet.
    const row = await roundRow(today.id);
    const q = await questionRow(today.questionId);
    const escrow = escrowConfigOf(row, q);
    expect(round.config).toEqual({
      beaconDelay: 120,
      overrides: [],
      free: { ...today.config.free, configHash: freeLockItem(row, q).configHash },
      stakes: {
        chainRoundId: '42',
        opensAt: escrow.opensAt,
        closesAt: escrow.closesAt,
        beaconRound: escrow.beaconRound,
        stake: escrow.stake.toString(),
        feeBps: escrow.feeBps,
        creatorBps: escrow.creatorBps,
        capMultiple: escrow.capMultiple,
        minEntrants: escrow.minEntrants,
        creator: PAYOUT,
        questionHash: escrow.questionHash,
        authorHandle: 'flock_author',
        payoutAddress: PAYOUT,
      },
    });
    expect(round.config?.free?.awardRecipient).toBe(author);
  });

  it('previousRoundId is null once every mode of the previous round is final', async () => {
    expect((await getToday()).previousRoundId).toBe(previous.id);
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'settled', final_at = ?2 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(previous.id, T)
      .run();
    // Stakes still revealing: still listed.
    expect((await getToday()).previousRoundId).toBe(previous.id);
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'refunded', refund_reason = 1, final_at = ?2 WHERE round_id = ?1 AND mode = 'stakes'",
    )
      .bind(previous.id, T)
      .run();
    expect(await getToday()).toMatchObject({ previousRoundId: null });
  });

  it('payoutAddress is null when the creator is the treasury; a house question has no author', async () => {
    const house = await getRound(previous.id);
    expect(house.question.author).toBeNull();
    expect(house.config?.stakes).toMatchObject({
      chainRoundId: '41',
      creator: TREASURY,
      authorHandle: null,
      payoutAddress: null,
    });
    const authored = await getRound(older.id);
    expect(authored.config?.stakes).toMatchObject({
      chainRoundId: '40',
      creator: TREASURY,
      authorHandle: 'flock_author',
      payoutAddress: null,
    });
    expect(authored.config?.free).toBeUndefined();
    expect(authored.modes.stakes).toMatchObject({ status: 'refunded', refundReason: 1 });
  });

  it('payoutAddress is the one frozen at lock, never the author’s current prefs (O4)', async () => {
    const setPrefs = (prefs: object) =>
      env.DB.prepare('UPDATE users SET prefs_json = ?2 WHERE id = ?1')
        .bind(author, JSON.stringify(prefs))
        .run();
    // The author clears, then changes, the payout wallet after the lock: the round still says PAYOUT.
    for (const prefs of [{}, { creator_payout_wallet: TREASURY }]) {
      await setPrefs(prefs);
      expect((await getRound(today.id)).config?.stakes?.payoutAddress).toBe(PAYOUT);
    }
    // A config locked before the field existed publishes none, whatever the prefs say.
    await setPrefs({ creator_payout_wallet: PAYOUT });
    const legacy = await insertRound({
      questionId: await insertQuestion({ authorId: author }),
      opensAt: OPENS - 3 * DAY_MS,
      closesAt: OPENS - 2 * DAY_MS,
      config: lockedConfig(['stakes'], { creator: PAYOUT }),
      modes: { stakes: { status: 'refunded', refundReason: 1, chainRoundId: '39' } },
    });
    expect((await getRound(legacy.id)).config?.stakes).toMatchObject({
      creator: PAYOUT,
      authorHandle: 'flock_author',
      payoutAddress: null,
    });
  });
});

/** The user's `daily_grant` ledger rows. */
async function grants(userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT delta, ref_id FROM points_ledger WHERE user_id = ?1 AND reason = 'daily_grant'",
  )
    .bind(userId)
    .all<{ delta: number; ref_id: string }>();
  return results;
}

async function balance(userId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = 'global'",
  )
    .bind(userId)
    .first<{ balance: number }>();
  return row?.balance ?? null;
}

/** An account old enough for the grant, with a linked Farcaster identity. */
async function eligible(balanceAt: number): Promise<string> {
  const u = await insertUser({ createdAt: T - 2 * DAY_MS, balance: balanceAt });
  await linkIdentity(u, 'farcaster', `fid-${u}`);
  return u;
}

const RPC = 'https://rpc.read.test';

/** A fake JSON-RPC provider at RPC: `nonces` by lowercase address; no code anywhere. */
function fakeRpc(nonces: Map<string, number>) {
  const calls: string[] = [];
  const answer = (req: { id: number; method: string; params: unknown[] }) => {
    calls.push(req.method);
    const address = String(req.params[0]).toLowerCase();
    const result =
      req.method === 'eth_getTransactionCount'
        ? `0x${(nonces.get(address) ?? 0).toString(16)}`
        : req.method === 'eth_getCode'
          ? '0x'
          : null;
    return { jsonrpc: '2.0', id: req.id, result };
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(RPC)) throw new Error(`unexpected fetch ${url}`);
    const text = input instanceof Request ? await input.text() : (init?.body as string);
    const body = JSON.parse(text) as Parameters<typeof answer>[0] | Parameters<typeof answer>[0][];
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
  });
  return { calls, env: { ...(env as Env), BASE_RPC_URL: RPC, BASE_RPC_URL_FALLBACK: undefined } };
}

describe('GET /rounds/today: the first-visit daily grant', () => {
  it('credits +100 on the first signed-in visit to the open daily round, and never twice', async () => {
    const u = await eligible(500);
    await getToday(u);
    expect(await grants(u)).toEqual([{ delta: 100, ref_id: today.id }]);
    expect(await balance(u)).toBe(600);
    setClock(T + HOUR);
    await getToday(u);
    expect(await grants(u)).toHaveLength(1);
    expect(await balance(u)).toBe(600);
  });

  it('a grant skipped at ≥ 1,000 stays skipped later that game day, though the balance dropped', async () => {
    const u = await eligible(1000);
    await getToday(u);
    const skip = await env.DB.prepare(
      'SELECT balance FROM daily_grant_skips WHERE user_id = ?1 AND round_id = ?2',
    )
      .bind(u, today.id)
      .first<{ balance: number }>();
    expect(skip).toEqual({ balance: 1000 });
    expect(await grants(u)).toEqual([]);
    // A Free stake (or anything else) takes it below 1,000 the same day; a later visit grants nothing.
    await env.DB.prepare(
      "UPDATE point_balances SET balance = 900 WHERE user_id = ?1 AND scope = 'global'",
    )
      .bind(u)
      .run();
    setClock(T + 3 * HOUR);
    await getToday(u);
    expect(await grants(u)).toEqual([]);
    expect(await balance(u)).toBe(900);
  });

  it('an anonymous visit grants nothing, and a visit with no open daily round grants nothing', async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM points_ledger WHERE reason = 'daily_grant'",
    ).first<{ n: number }>();
    expect((await getToday()).round?.id).toBe(today.id);
    const u = await eligible(500);
    setClock(CLOSES + HOUR);
    expect((await getToday(u)).round).toBeNull();
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM points_ledger WHERE reason = 'daily_grant'",
    ).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect(await grants(u)).toEqual([]);
  });

  it('a wallet-only account becomes eligible once its wallet has a prior onchain transaction', async () => {
    const fresh = await insertUser({ createdAt: T - 2 * DAY_MS });
    const freshWallet = `0x${'5a'.repeat(20)}`;
    await linkIdentity(fresh, 'wallet', freshWallet);
    const used = await insertUser({ createdAt: T - 2 * DAY_MS });
    const usedWallet = `0x${'5b'.repeat(20)}`;
    await linkIdentity(used, 'wallet', usedWallet);
    const rpc = fakeRpc(new Map([[usedWallet, 3]]));

    await getToday(fresh, rpc.env);
    expect(rpc.calls).toContain('eth_getTransactionCount');
    expect(await grants(fresh)).toEqual([]);
    expect(await balance(fresh)).toBe(500);
    // Not eligible: no skip row either, so linking later the same day still works.
    const skip = await env.DB.prepare('SELECT 1 FROM daily_grant_skips WHERE user_id = ?1')
      .bind(fresh)
      .first();
    expect(skip).toBeNull();

    await getToday(used, rpc.env);
    expect(await grants(used)).toEqual([{ delta: 100, ref_id: today.id }]);
    expect(await balance(used)).toBe(600);
    const identity = await env.DB.prepare(
      "SELECT json_extract(data_json, '$.priorTxAt') AS at FROM identities WHERE user_id = ?1",
    )
      .bind(used)
      .first<{ at: number }>();
    expect(identity?.at).toBe(T);
  });
});

describe('GET /rounds/:id', () => {
  it('a settled Free round: tally, winner, pools, payout root, bundle hash, the manifest anchor, settledAt', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1, 0, 1]);
    await questionFor(r.roundId);
    const h = await harness(r.roundId, { apply: 'real' });
    expect(await h.run()).toMatchObject({ phase: 'done', error: null });
    const result = h.applied[0];
    if (!result) throw new Error('not applied');

    // The manifest anchor, as the indexer records `ManifestAnchored` (its round key comes from the
    // mirrored `Locked`).
    const key = roundKey(r.roundId, 'free');
    const closesAt = (await roundRow(r.roundId)).closes_at;
    await env.DB.prepare(
      `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash,
         log_index, event, args_json, created_at, updated_at)
       VALUES (31337, ?1, 1, ?2, 0, ?3, 0, 'Locked', ?4, 0, 0)`,
    )
      .bind(
        FAKE_ANCHOR,
        `0x${'0b'.repeat(32)}`,
        `0x${'0c'.repeat(32)}`,
        JSON.stringify({ roundKey: key, closesAt: String(closesAt / 1000) }),
      )
      .run();
    const anchorTx: Hex = `0x${'a7'.repeat(32)}`;
    await index([
      {
        chainId: 31337,
        contract: FAKE_ANCHOR,
        contractKind: 'anchor',
        blockNumber: 5,
        blockHash: `0x${'0d'.repeat(32)}`,
        blockTimestampSec: BEACON_TIME_MS / 1000 + 30,
        txHash: anchorTx,
        logIndex: 0,
        event: 'ManifestAnchored',
        args: { roundKey: key, manifestHash: result.bundleHash },
        removed: false,
        revision: 0,
      },
    ]);

    const round = await getRound(r.roundId);
    const rec = result.record;
    expect(round.modes.free).toEqual({
      status: 'settled',
      entrantCount: 5,
      pool: '50',
      chainRoundId: null,
      revealedAt: BEACON_TIME_MS + 5_000,
      claimsOpenAt: null,
      finalAt: BEACON_TIME_MS + 5_000,
      refundReason: null,
      settlement: {
        proposalSeq: 0,
        outcome: 'settled',
        formulaVersion: 1,
        winningOption: 0,
        tally: [
          { headcount: 2, total: '20' },
          { headcount: 3, total: '30' },
        ],
        lossPool: rec.lossPool.toString(),
        fee: '0',
        creatorFee: '0',
        distributable: rec.distributable.toString(),
        rebatePool: rec.rebatePool.toString(),
        dust: rec.dust.toString(),
        payoutRoot: result.manifest.payoutRoot,
        bundleHash: result.bundleHash,
        txHash: anchorTx,
        settledAt: BEACON_TIME_MS + 5_000,
      },
    });
    expect(rec.winner).toBe(0);
    expect(round.question.prompt).toMatch(/^Cats or dogs\?/);
  });

  it('past beacon time a closed round’s pending modes read revealing, as in the WebSocket state (W8-F1)', async () => {
    const beaconMs = (n: number) =>
      (Number(env.DRAND_GENESIS) + (n - 1) * Number(env.DRAND_PERIOD)) * 1000;
    const closed = async (closesAt: number) => {
      const beaconRound = beaconRoundAtOrAfter(closesAt / 1000 + 120);
      const r = await insertRound({
        opensAt: closesAt - DAY_MS,
        closesAt,
        beaconRound,
        status: 'closed',
        modes: { free: {}, stakes: { status: 'refunded', refundReason: 2 } },
      });
      return { ...r, beaconMs: beaconMs(beaconRound) };
    };
    const past = await closed(CLOSES + 20 * DAY_MS);
    const ahead = await closed(CLOSES + 21 * DAY_MS);
    setClock(past.beaconMs);
    expect(ahead.beaconMs).toBeGreaterThan(past.beaconMs);
    const modesOf = async (id: string) => (await getRound(id)).modes;
    // A final mode keeps its status; only `pending` moves, and only past beacon time.
    expect(await modesOf(past.id)).toMatchObject({
      free: { status: 'revealing' },
      stakes: { status: 'refunded' },
    });
    expect(await modesOf(ahead.id)).toMatchObject({
      free: { status: 'pending' },
      stakes: { status: 'refunded' },
    });
  });

  it('404 for a round that is not locked yet, and for an unknown round', async () => {
    const unlocked = await insertRound({
      opensAt: CLOSES + DAY_MS,
      closesAt: CLOSES + 2 * DAY_MS,
      status: 'scheduled',
      locked: false,
    });
    for (const id of [unlocked.id, newUlid()]) {
      const res = await request(`/rounds/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });
});
