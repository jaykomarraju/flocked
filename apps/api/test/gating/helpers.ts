// Reveal-gating test helpers (W6-D): requests through the real app (session middleware, routes, D1,
// R2 and the DOs of the env passed), signed-in users with real sessions, Free and Stakes rounds seeded
// as test/settlement seeds them and driven through the real settlement pipeline up to the dangerous
// window (per-option data written to D1 and R2, `revealed_at` still null), and a recursive scan of
// response bodies for per-option data.
import { env } from 'cloudflare:test';
import { freeCommitmentTree } from '@flocked/settle';
import {
  API_BASE_PATH,
  ENDPOINTS,
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  MODE_CODES,
  newUlid,
  roundKey,
  ulidToBytes,
  type EndpointDef,
  type LockedConfig,
  type Mode,
} from '@flocked/shared';
import { QUICKNET, encodePlaintext, encryptPick, roundRefFromChainId } from '@flocked/tlock';
import { bytesToHex, keccak256, type Hex } from 'viem';
import { expect } from 'vitest';
import { app } from '../../src/app.js';
import { receiptUserIdHash } from '../../src/crypto/receipt.js';
import type { Env } from '../../src/env.js';
import { applyFree } from '../../src/settlement/apply/free.js';
import type { TallyResult } from '../../src/settlement/types.js';
import { realSession } from '../helpers/index.js';
import {
  BEACON,
  BEACON_TIME_MS,
  atBeaconPlus,
  harness,
  pick,
  tamperedPick,
  recordedDeps,
  type SeededRound,
} from '../settlement/helpers.js';
import { FakeEscrowChain, eventsOf } from '../settlement/stakes-chain.js';
import {
  index,
  setGameClock,
  stakesHarness,
  type Pick,
  type SeededStakes,
  type SeededStakesEntry,
  type StakesHarness,
} from '../settlement/stakes-helpers.js';

export const ORIGIN = 'https://flocked.test';
export const HOUR = 3_600_000;

const randomHex = (bytes: number): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

export const randomWallet = (): string => randomHex(20);

// Requests --------------------------------------------------------------------------------------

/** The global env with the game clock pinned at `t` (epoch ms) for this request only. */
export function at(t: number, overrides: Partial<Env> = {}): Env {
  return { ...env, ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(t), ...overrides };
}

export interface Answer {
  status: number;
  headers: Headers;
  /** The JSON body (null when the body isn't JSON). */
  json: unknown;
  bytes: Uint8Array;
}

/** GET `path` (relative to /api/v1) through the real app with `e`. */
export async function get(
  e: Env,
  path: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const res = await app.request(`${ORIGIN}${API_BASE_PATH}${path}`, { headers }, e);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let json: unknown = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  return { status: res.status, headers: res.headers, json, bytes };
}

let handles = 0;

/** A users row (as sign-up and the handle step leave it) for `id`, if there isn't one. */
export async function ensureUser(id: string): Promise<void> {
  handles += 1;
  await env.DB.prepare(
    `INSERT INTO users (id, handle, display_name, ref_code, tos_version, tos_accepted_at, age_attested_at, created_at)
     VALUES (?1, ?2, ?2, ?3, '2026-10-01', 1759000000000, 1759000000000, 1759000000000)
     ON CONFLICT (id) DO NOTHING`,
  )
    .bind(id, `gate_${handles}_${id.slice(-6).toLowerCase()}`, `GATE${id.slice(-8)}`)
    .run();
}

/**
 * Bearer headers of a real session for `userId` (a users row is added when missing). The session
 * never expires, so it holds on the pinned game clock and on wall time alike.
 */
export async function signIn(userId: string): Promise<Record<string, string>> {
  await ensureUser(userId);
  const s = await realSession(env, userId, 'bearer');
  await env.DB.prepare('UPDATE sessions SET expires_at = ?2 WHERE id_hash = ?1')
    .bind(s.idHash, Number.MAX_SAFE_INTEGER)
    .run();
  return s.headers;
}

// Rounds ----------------------------------------------------------------------------------------

/** A house question row for a seeded round (the read models join `questions`). */
function questionRow(id: string, createdAt: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at)
     VALUES (?1, NULL, 'Cats or dogs?', ?2, 'other', 'used', ?3)`,
  ).bind(
    id,
    JSON.stringify([
      { label: 'Cats', emoji: '🐈' },
      { label: 'Dogs', emoji: '🐕' },
    ]),
    createdAt,
  );
}

let freeSeeded = 0;

/**
 * A locked Free round targeting the recorded beacon (BEACON.round), closed, pending, with one real
 * tlock pick per option (stake 10 each, in seq order), the commitment anchored over all of them and
 * the indexer's mirrored `Committed` row: test/settlement's `seedFreeRound`, plus a question row, real
 * times and the round's kind (a `room` round when `room` is given). A locked round can't change (the
 * `rounds_locked_immutable` trigger), so it is inserted as the reads need it. Each daily close is
 * hours before the Stakes rounds' (BEACON_TIME_MS − 120 s − k s), so the windows don't overlap.
 */
export async function seedFree(
  picks: readonly Pick[],
  opts: { room?: string } = {},
): Promise<SeededRound> {
  const roundId = newUlid();
  freeSeeded += 1;
  const closesAt = BEACON_TIME_MS - 3 * HOUR - freeSeeded * 60_000;
  const opensAt = closesAt - 24 * HOUR;
  const config = LockedConfigSchema.parse({
    beaconDelay: 120,
    free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
  });
  const rows = await Promise.all(
    picks.map(async (o, seq) => {
      // A VOID: a plaintext whose option index is 2 (`bad_option`).
      const ct = o === 'void' ? await tamperedPick(roundId, 17, 2) : await pick(roundId, o);
      const userId = newUlid();
      const userIdHash = receiptUserIdHash(roundId, userId);
      return { id: newUlid(), userId, userIdHash, stake: 10, commitment: keccak256(ct), ct, seq };
    }),
  );
  const root = freeCommitmentTree(
    rows.map((r) => ({
      roundId: ulidToBytes(roundId),
      mode: MODE_CODES.free,
      userIdHash: r.userIdHash,
      stake: BigInt(r.stake),
      commitment: r.commitment,
      seq: r.seq,
    })),
  ).root;
  const commitTx = randomHex(32);
  const questionId = newUlid();
  const db = env.DB;
  await db.batch([
    questionRow(questionId, opensAt - 7 * 24 * HOUR),
    db
      .prepare(
        `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'closed', ?8, ?9)`,
      )
      .bind(
        roundId,
        opts.room ? 'room' : 'daily',
        opts.room ?? null,
        questionId,
        opensAt,
        closesAt,
        BEACON.round,
        opensAt - 6 * HOUR,
        JSON.stringify(config),
      ),
    db
      .prepare(
        "INSERT INTO round_modes (round_id, mode, status, commitment_root, commit_tx) VALUES (?1, 'free', 'pending', ?2, ?3)",
      )
      .bind(roundId, root, commitTx),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO entries (id, round_id, mode, user_id, stake, ciphertext, commitment, receipt_seq, created_at)
           VALUES (?1, ?2, 'free', ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(r.id, roundId, r.userId, r.stake, r.ct, r.commitment, r.seq, closesAt - 60_000),
    ),
    // The indexer's mirrored `Committed(roundKey, root, entryCount, totalStake)`, before the beacon.
    db
      .prepare(
        `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash,
           log_index, event, args_json, created_at, updated_at)
         VALUES (31337, ?1, 1, ?2, ?3, ?4, 0, 'Committed', ?5, 0, 0)`,
      )
      .bind(
        `0x${'aa'.repeat(20)}`,
        randomHex(32),
        Math.floor(closesAt / 1000) + 10,
        commitTx,
        JSON.stringify({
          roundKey: roundKey(roundId, 'free'),
          commitmentRoot: root,
          entryCount: String(rows.length),
          totalStake: String(rows.reduce((s, r) => s + r.stake, 0)),
        }),
      ),
  ]);
  return {
    roundId,
    config,
    entries: rows.map(({ id, userId, userIdHash, stake, commitment }) => ({
      id,
      userId,
      userIdHash,
      stake,
      commitment,
    })),
    root,
    commitTx,
  };
}

let stakesSeeded = 0;

/** A Stakes pick sealed to the onchain round reference; a VOID opens to option index 2. */
async function sealed(chainRoundId: bigint, p: Pick): Promise<Uint8Array> {
  const pt = encodePlaintext({
    roundRef: roundRefFromChainId(chainRoundId),
    optionIndex: p === 'void' ? 0 : p,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
  });
  if (p === 'void') pt[17] = 2;
  return encryptPick(QUICKNET, BEACON.round, pt);
}

/**
 * A locked daily Stakes round targeting BEACON.round, closed in D1, pending, with one `Entered` per
 * pick on its own fake escrow chain and the indexer's `entries` rows: test/settlement's `seedStakes`
 * (the same timing against the chain, minEntrants 3), plus a question row and real lock and entry
 * times. `room` makes it a room round; `players` sets the wallets of the first entries.
 */
export async function seedStakesRound(
  picks: readonly Pick[],
  opts: { room?: string; players?: Hex[] } = {},
): Promise<SeededStakes> {
  const roundId = newUlid();
  const chainRoundId = BigInt(900 + stakesSeeded);
  const closesAt = BEACON_TIME_MS - 120_000 - 1000 * stakesSeeded++;
  const opensAt = closesAt - 24 * HOUR;
  const closesAtSec = closesAt / 1000;
  const config = LockedConfigSchema.parse({
    beaconDelay: 120,
    stakes: { ...LOCKED_CONFIG_DEFAULTS.stakes, minEntrants: 3, creator: `0x${'de'.repeat(20)}` },
  });
  const s = config.stakes as NonNullable<LockedConfig['stakes']>;
  const stake = BigInt(s.stake);
  // Block n is stamped t0 + 2n: the head starts 200 s before close.
  const chain = new FakeEscrowChain(closesAtSec - 200 - 2 * 1000, 1000);
  chain.addRound(chainRoundId, {
    stake,
    minEntrants: s.minEntrants,
    feeBps: s.feeBps,
    creatorBps: s.creatorBps,
    capMultiple: s.capMultiple,
    closesAt: closesAtSec,
  });
  const entries: SeededStakesEntry[] = [];
  for (const [i, p] of picks.entries()) {
    const ct = await sealed(chainRoundId, p);
    const e = chain.enter(chainRoundId, {
      txHash: randomHex(32),
      player: opts.players?.[i] ?? randomHex(20),
      personTag: randomHex(32),
      ticketHash: randomHex(32),
      ciphertext: bytesToHex(ct),
    });
    entries.push({
      id: newUlid(),
      userId: newUlid(),
      wallet: e.player.toLowerCase() as Hex,
      personTag: e.personTag,
      txHash: e.txHash,
      block: e.block,
      ct,
      pick: p,
    });
  }
  const questionId = newUlid();
  const db = env.DB;
  await db.batch([
    questionRow(questionId, opensAt - 7 * 24 * HOUR),
    db
      .prepare(
        `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'closed', ?8, ?9)`,
      )
      .bind(
        roundId,
        opts.room ? 'room' : 'daily',
        opts.room ?? null,
        questionId,
        opensAt,
        closesAt,
        BEACON.round,
        opensAt - 6 * HOUR,
        JSON.stringify(config),
      ),
    db
      .prepare(
        "INSERT INTO round_modes (round_id, mode, status, chain_round_id) VALUES (?1, 'stakes', 'pending', ?2)",
      )
      .bind(roundId, chainRoundId.toString()),
    ...entries.map((e) =>
      db
        .prepare(
          `INSERT INTO entries (id, round_id, mode, user_id, foreign_entry, wallet, person_tag, stake, ciphertext,
             commitment, tx_hash, block_number, log_index, created_at)
           VALUES (?1, ?2, 'stakes', ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11)`,
        )
        .bind(
          e.id,
          roundId,
          e.userId,
          e.wallet,
          e.personTag,
          Number(stake),
          e.ct,
          keccak256(e.ct),
          e.txHash,
          e.block,
          closesAt - 60_000,
        ),
    ),
  ]);
  return { roundId, chainRoundId, closesAt, config, stake, entries, chain };
}

/** Back to taking entries: the round's status `open` (as it was before its close alarm). */
export async function reopen(roundId: string): Promise<void> {
  await env.DB.prepare("UPDATE rounds SET status = 'open' WHERE id = ?1").bind(roundId).run();
}

/** Closes the round, as the RoundDO's close alarm does. */
export async function close(roundId: string): Promise<void> {
  await env.DB.prepare("UPDATE rounds SET status = 'closed' WHERE id = ?1").bind(roundId).run();
}

export async function roundTimes(roundId: string) {
  const r = await env.DB.prepare('SELECT opens_at, closes_at FROM rounds WHERE id = ?1')
    .bind(roundId)
    .first<{ opens_at: number; closes_at: number }>();
  if (!r) throw new Error(`no round ${roundId}`);
  return { opensAt: r.opens_at, closesAt: r.closes_at };
}

// The dangerous window --------------------------------------------------------------------------

/** An env whose D1 refuses applyFree's step 4 (the `revealing → settled` update with revealed_at). */
function crashBeforeReveal(): Env {
  const db = env.DB;
  const crashing = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (/UPDATE round_modes SET status = \?2[\s\S]*revealed_at = \?5/.test(sql)) {
            throw new Error('injected crash before the reveal');
          }
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { ...env, DB: crashing };
}

export interface FreeWindow {
  result: TallyResult;
  /** The settlement's retry: applyFree again, which sets `revealed_at` (the reveal). */
  reveal(): Promise<void>;
}

/**
 * Runs the real Free pipeline (SettlementDO: beacon, decrypt, reduce, the bundle written to R2) and
 * the real applyFree, crashed just before its step 4: the settlement record, the entries' option,
 * validity and VOID reason, the payouts and ledger credits are in D1 and the bundle is in R2, while
 * the mode is still `revealing` with `revealed_at` null. That is what a crash between steps 3 and 4
 * leaves (and what readers see while steps 1–3 run); the SettlementDO's retry then completes it.
 */
export async function freeToWindow(
  roundId: string,
  opts: { bundleChunk?: number } = {},
): Promise<FreeWindow> {
  atBeaconPlus(5_000);
  const sizes = { decrypt: 4, bundle: opts.bundleChunk ?? 8 };
  const h = await harness(roundId, { apply: 'record', sizes });
  expect(await h.run()).toMatchObject({ phase: 'done', error: null });
  const result = h.applied[0];
  if (!result) throw new Error('freeToWindow: nothing applied');
  const deps = recordedDeps().deps;
  await expect(applyFree(crashBeforeReveal(), result, deps)).rejects.toThrow(/injected crash/);
  expect(await modeRow(roundId, 'free')).toMatchObject({ status: 'revealing', revealed_at: null });
  return { result, reveal: () => applyFree(env, result, deps) };
}

export interface StakesWindow {
  h: StakesHarness;
  /** The indexer handling the proposal's `OutcomeProposed` (sets `revealed_at`: the reveal). */
  reveal(): Promise<void>;
  /** finalize at claimsOpenAt, and the indexer handling `RoundFinalized` (the payouts rows). */
  finalize(): Promise<void>;
}

/**
 * Runs the real Stakes pipeline against the fake escrow (test/settlement/stakes-helpers.ts) to the
 * proposal: applyStakes has written the settlement record, the entries' outcomes,
 * `round_modes.bundle_hash` and the bundle, and `propose` is mined, but the indexer hasn't handled
 * `OutcomeProposed`, so `revealed_at` is null.
 */
export async function stakesToWindow(r: SeededStakes): Promise<StakesWindow> {
  r.chain.advanceTo(r.closesAt / 1000 + 4);
  setGameClock(BEACON_TIME_MS + 5_000);
  const h = await stakesHarness(r);
  await h.start();
  expect(await h.alarm()).toMatchObject({ phase: 'decrypting' });
  await h.deliver();
  expect(await h.alarm()).toMatchObject({ phase: 'proposing', error: null });
  expect(r.chain.calls).toEqual([`propose:${r.chainRoundId}`]);
  expect(await modeRow(r.roundId, 'stakes')).toMatchObject({
    status: 'revealing',
    revealed_at: null,
  });
  return {
    h,
    reveal: () => index(eventsOf(r.chain, r.chain.lastTx('propose'))),
    finalize: async () => {
      const at = r.chain.round(r.chainRoundId).claimsOpenAt;
      setGameClock(at * 1000);
      r.chain.advanceTo(at);
      for (let i = 0; i < 5 && (await h.alarm()).phase !== 'done'; i++);
      await index(eventsOf(r.chain, r.chain.lastTx('finalize')));
    },
  };
}

export async function modeRow(roundId: string, mode: Mode) {
  return env.DB.prepare(
    'SELECT status, revealed_at, bundle_hash FROM round_modes WHERE round_id = ?1 AND mode = ?2',
  )
    .bind(roundId, mode)
    .first<{ status: string; revealed_at: number | null; bundle_hash: string | null }>();
}

/** The bundle objects of a (round, mode) in R2, key → bytes. */
export async function r2Bundle(roundId: string, mode: Mode): Promise<Map<string, Uint8Array>> {
  const listed = await env.BUCKET.list({ prefix: `bundles/${roundId}/${mode}/` });
  const out = new Map<string, Uint8Array>();
  for (const o of listed.objects) {
    const obj = await env.BUCKET.get(o.key);
    if (obj) out.set(o.key, new Uint8Array(await obj.arrayBuffer()));
  }
  return out;
}

// Endpoints -------------------------------------------------------------------------------------

/** Every GET route of the pinned table. */
export const GET_ENDPOINTS: readonly EndpointDef[] = ENDPOINTS.filter((e) => e.method === 'GET');

const SAMPLE_PARAMS: Record<string, string> = {
  shareId: 'Sh4reId_01',
  variant: 'og.png',
  handle: 'ewe_one',
  board: 'strays',
  gameDay: '2026-10-08',
};

/** Fills the path's `:name` and `:name{regex}` segments (`id` by the path's resource). */
export function concretePath(path: string, ids: { round: string; room: string; user: string }) {
  return path.replace(/:([A-Za-z_]+)(\{[^/]*\})?/g, (_m, name: string) => {
    if (name === 'id') {
      if (path.startsWith('/rooms/')) return ids.room;
      if (path.startsWith('/admin/users/') || path.startsWith('/me/')) return ids.user;
      return ids.round;
    }
    const v = SAMPLE_PARAMS[name];
    if (v === undefined) throw new Error(`no sample for :${name} in ${path}`);
    return v;
  });
}

// The leak scan ---------------------------------------------------------------------------------

/** Keys that carry per-option data (or point at it) whenever their value isn't null. */
const PER_OPTION_KEYS = new Set([
  'tally',
  'winningOption',
  'winner',
  'optionIndex',
  'valid',
  'voidReason',
  'voids',
  'settlement',
  'payoutRoot',
  'bundleHash',
  'manifestUrl',
  'proof',
  'headcount',
  'n',
  'w',
]);
const OUTCOME_RESULTS = new Set(['win', 'loss', 'void']);
const OUTCOME_PAYOUTS = new Set(['win', 'rebate', 'void_refund']);

/**
 * Every place in `body` that carries per-option data: a non-null tally, winner, option, validity,
 * VOID reason, settlement, payout root, bundle hash or URL, claim proof, per-option `n`/`w` or
 * headcount; a result of win, loss or void; a payout or claim of kind win, rebate or void_refund;
 * a non-empty chunk URL list; a refund reason that says how the picks fell (2 one-sided, 3 tie).
 */
export function perOptionData(body: unknown, path = '$'): string[] {
  const out: string[] = [];
  const visit = (node: unknown, p: string) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${p}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const at = `${p}.${k}`;
      const show = `${at} = ${JSON.stringify(v)?.slice(0, 80)}`;
      if (PER_OPTION_KEYS.has(k) && v !== null && v !== undefined) out.push(show);
      if (k === 'result' && typeof v === 'string' && OUTCOME_RESULTS.has(v)) out.push(show);
      if (k === 'kind' && typeof v === 'string' && OUTCOME_PAYOUTS.has(v)) out.push(show);
      if (k === 'chunkUrls' && Array.isArray(v) && v.length > 0) out.push(show);
      if (k === 'refundReason' && (v === 2 || v === 3)) out.push(show);
      visit(v, at);
    }
  };
  visit(body, path);
  return out;
}
