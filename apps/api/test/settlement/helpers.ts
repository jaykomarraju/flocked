// Settlement test helpers. Rounds target a recorded quicknet beacon (public data, from
// packages/tlock/fixtures/quicknet-beacons.json), so every ciphertext is a real tlock ciphertext
// opened with that round's real signature and no BLS key is needed. The relays are faked through
// SettlementDO.relayFetch, the decrypt queues are recorded, and the tests deliver the recorded
// messages to the real consumer. D1, R2 and DO storage are shared within a test file, so each test
// makes its own round.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { freeCommitmentTree } from '@flocked/settle';
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  MODE_CODES,
  newUlid,
  roundKey,
  ulidToBytes,
  type AlertCode,
  type DecryptMessage,
  type LockedConfig,
  type Mode,
} from '@flocked/shared';
import {
  QUICKNET,
  beaconTime,
  encodePlaintext,
  encryptPick,
  roundRefFromChainId,
  roundRefFromUlid,
} from '@flocked/tlock';
import { bytesToHex, keccak256, type Hex } from 'viem';
import { vi, type MockInstance } from 'vitest';
import { receiptUserIdHash } from '../../src/crypto/receipt.js';
import { settlementName, type SettlementDO } from '../../src/do/settlement-do.js';
import type { AnchorManifestItem, ModeResult, SettlementStatus } from '../../src/do/types.js';
import { decryptHandler } from '../../src/queues/decrypt.js';
import { applyFree, refundFree, type FreeApplyDeps } from '../../src/settlement/apply/free.js';
import type { TallyResult } from '../../src/settlement/types.js';

/** Recorded quicknet beacons. */
export const BEACON = {
  round: 32_870_075,
  signature:
    '85c653c4e0099d069e9f7f525d14239c5f2ffa496f02ad5daf4e4e240de575261d5248172ad543b351b236c838853d8e',
};
export const OTHER_ROUND = {
  round: 32_870_000,
  signature:
    '84367383186c224e66870840bd23cacfdfdf26bc762166eddb2216404e49814230f444ff4a1c6dcf8eaf420c5409e5cc',
};
export const BEACON_TIME_MS = beaconTime(QUICKNET, BEACON.round) * 1000;
export const RELAYS = ['https://relay-a.test', 'https://relay-b.test'] as const;

/** Pins the game clock `ms` after beacon time and points the DO at the fake relays. */
export function atBeaconPlus(ms: number): void {
  Object.assign(env, {
    ENVIRONMENT: 'local',
    FLOCKED_TEST_CLOCK: String(BEACON_TIME_MS + ms),
    DRAND_RELAYS: RELAYS.join(','),
  });
}

// Ciphertexts -----------------------------------------------------------------------------------

const nonce = () => crypto.getRandomValues(new Uint8Array(16));

/** A valid pick for the round, sealed to `beaconRound`. */
export function pick(roundId: string, option: 0 | 1, beaconRound = BEACON.round) {
  const pt = encodePlaintext({
    roundRef: roundRefFromUlid(roundId),
    optionIndex: option,
    nonce: nonce(),
  });
  return encryptPick(QUICKNET, beaconRound, pt);
}

/** A 34-byte plaintext for the round with one byte changed (0: version; 17: optionIndex). */
export function tamperedPick(roundId: string, at: number, value: number) {
  const pt = encodePlaintext({
    roundRef: roundRefFromUlid(roundId),
    optionIndex: 0,
    nonce: nonce(),
  });
  pt[at] = value;
  return encryptPick(QUICKNET, BEACON.round, pt);
}

/** One ciphertext per VOID reason `classify` decides, from real tlock ciphertexts. */
export async function voidCiphertexts(roundId: string) {
  const flipped = await pick(roundId, 0);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
  return {
    non_canonical_header: new TextEncoder().encode('this is not an age file\n'),
    wrong_target: await pick(roundId, 0, OTHER_ROUND.round),
    decrypt_failed: flipped,
    bad_plaintext: await tamperedPick(roundId, 0, 0x02),
    bad_option: await tamperedPick(roundId, 17, 2),
  };
}

// Rounds ----------------------------------------------------------------------------------------

export interface SeedEntry {
  ct: Uint8Array;
  stake?: number;
}

export interface SeededRound {
  roundId: string;
  config: LockedConfig;
  /** Entry IDs and user IDs, by seq. */
  entries: { id: string; userId: string; userIdHash: Hex; stake: number; commitment: Hex }[];
  root: Hex | null;
  commitTx: Hex | null;
}

let seeded = 0;
const randomHex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

/**
 * A locked daily Free round targeting BEACON.round, pending, with `entries` committed by seq and
 * the commitment anchored over the first `anchored` of them (all by default). `mirror` adds the
 * indexer's `Committed` row, which carries the anchored entry count.
 */
export async function seedFreeRound(
  make: (roundId: string) => Promise<SeedEntry[]>,
  opts: { anchored?: number; mirror?: boolean; free?: Partial<LockedConfig['free']> } = {},
): Promise<SeededRound> {
  const roundId = newUlid();
  const entries = await make(roundId);
  // Daily close times are unique; every seeded round still targets BEACON.round.
  const closesAt = BEACON_TIME_MS - 120_000 - 1000 * seeded++;
  const config = LockedConfigSchema.parse({
    beaconDelay: 120,
    free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null, ...opts.free },
  });
  const rows = entries.map((e, seq) => {
    const userId = newUlid();
    return {
      id: newUlid(),
      userId,
      userIdHash: receiptUserIdHash(roundId, userId),
      stake: e.stake ?? 10,
      commitment: keccak256(e.ct),
      ct: e.ct,
      seq,
    };
  });
  const anchored = rows.slice(0, opts.anchored ?? rows.length);
  const root =
    anchored.length === 0
      ? null
      : freeCommitmentTree(
          anchored.map((r) => ({
            roundId: ulidToBytes(roundId),
            mode: MODE_CODES.free,
            userIdHash: r.userIdHash,
            stake: BigInt(r.stake),
            commitment: r.commitment,
            seq: r.seq,
          })),
        ).root;
  const commitTx = root ? randomHex(32) : null;
  const db = env.DB;
  const stmts = [
    db
      .prepare(
        `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json)
         VALUES (?1, 'daily', NULL, ?2, ?3, ?4, ?5, 'closed', ?6, ?7)`,
      )
      .bind(
        roundId,
        newUlid(),
        closesAt - 86_400_000,
        closesAt,
        BEACON.round,
        closesAt - 86_400_000 - 21_600_000,
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
        .bind(r.id, roundId, r.userId, r.stake, r.ct, r.commitment, r.seq, closesAt - 1000),
    ),
  ];
  if (opts.mirror && commitTx && root) {
    stmts.push(
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
            entryCount: String(anchored.length),
            totalStake: String(anchored.reduce((s, r) => s + r.stake, 0)),
          }),
        ),
    );
  }
  await db.batch(stmts);
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

/** A round whose entries are valid picks for `options`, by seq. */
export function seedPicks(
  options: readonly (0 | 1)[],
  opts: Parameters<typeof seedFreeRound>[1] = {},
): Promise<SeededRound> {
  return seedFreeRound(
    (roundId) => Promise.all(options.map(async (o) => ({ ct: await pick(roundId, o) }))),
    opts,
  );
}

/**
 * A locked daily Stakes round (onchain round `chainRoundId`) targeting BEACON.round, pending, with
 * one mirrored `Entered` entry per option, in block order.
 */
export async function seedStakesRound(
  options: readonly (0 | 1)[],
  chainRoundId = 7n,
): Promise<{ roundId: string; wallets: Hex[] }> {
  const roundId = newUlid();
  const closesAt = BEACON_TIME_MS - 120_000 - 1000 * seeded++;
  const config = LockedConfigSchema.parse({
    beaconDelay: 120,
    stakes: { ...LOCKED_CONFIG_DEFAULTS.stakes, creator: `0x${'de'.repeat(20)}` },
  });
  const roundRef = roundRefFromChainId(chainRoundId);
  const rows = await Promise.all(
    options.map(async (o, i) => {
      const ct = await encryptPick(
        QUICKNET,
        BEACON.round,
        encodePlaintext({ roundRef, optionIndex: o, nonce: nonce() }),
      );
      return { id: newUlid(), userId: newUlid(), wallet: randomHex(20), ct, block: 100 + i };
    }),
  );
  const db = env.DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json)
         VALUES (?1, 'daily', NULL, ?2, ?3, ?4, ?5, 'closed', ?6, ?7)`,
      )
      .bind(
        roundId,
        newUlid(),
        closesAt - 86_400_000,
        closesAt,
        BEACON.round,
        1,
        JSON.stringify(config),
      ),
    db
      .prepare(
        "INSERT INTO round_modes (round_id, mode, status, chain_round_id) VALUES (?1, 'stakes', 'pending', ?2)",
      )
      .bind(roundId, chainRoundId.toString()),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO entries (id, round_id, mode, user_id, wallet, person_tag, stake, ciphertext, commitment,
             tx_hash, block_number, log_index, created_at)
           VALUES (?1, ?2, 'stakes', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 1)`,
        )
        .bind(
          r.id,
          roundId,
          r.userId,
          r.wallet,
          randomHex(32),
          Number(config.stakes?.stake),
          r.ct,
          keccak256(r.ct),
          randomHex(32),
          r.block,
        ),
    ),
  ]);
  return { roundId, wallets: rows.map((r) => r.wallet) };
}

export async function modeStatus(roundId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT status FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
  )
    .bind(roundId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

// Relays, queues, alerts ------------------------------------------------------------------------

export type RelayAnswer = 'ok' | 'missing' | 'bad_signature' | 'wrong_round' | 'down';

/** A fake `fetch` for the relays: `plan(relay, call)` picks each answer; `calls` records URLs. */
export function fakeRelays(plan: (relay: string, call: number) => RelayAnswer) {
  const calls: string[] = [];
  const fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const relay = RELAYS.find((r) => url.startsWith(r)) ?? url;
    const round = Number(url.split('/').pop());
    const answer = plan(relay, calls.length);
    if (answer === 'down') return Promise.reject(new TypeError('network down'));
    if (answer === 'missing') return Promise.resolve(new Response('not yet', { status: 425 }));
    const sig =
      answer === 'bad_signature'
        ? `${BEACON.signature.slice(0, -1)}${BEACON.signature.endsWith('e') ? 'f' : 'e'}`
        : round === BEACON.round
          ? BEACON.signature
          : OTHER_ROUND.signature;
    return Promise.resolve(
      Response.json({ round: answer === 'wrong_round' ? round + 1 : round, signature: sig }),
    );
  };
  return { fetch, calls };
}

/** Records the decrypt queues' messages instead of sending them. */
export function recordDecryptQueues(): DecryptMessage[] {
  const sent: DecryptMessage[] = [];
  const recorder = {
    send: (body: DecryptMessage) => {
      sent.push(body);
      return Promise.resolve();
    },
    sendBatch: (msgs: { body: DecryptMessage }[]) => {
      for (const m of msgs) sent.push(m.body);
      return Promise.resolve();
    },
  };
  Object.assign(env, { QUEUE_DECRYPT_DAILY: recorder, QUEUE_DECRYPT_ROOMS: recorder });
  return sent;
}

/** Spies on Analytics Engine writes; `codes()` lists the alert codes raised since. */
export function alertSpy(): { codes(): AlertCode[]; spy: MockInstance } {
  const spy = vi.spyOn(env.ANALYTICS, 'writeDataPoint');
  return {
    spy,
    codes: () => spy.mock.calls.map((c) => (c[0] as { indexes: [AlertCode] }).indexes[0]),
  };
}

// The DO ----------------------------------------------------------------------------------------

export function settlement(roundId: string, mode: Mode = 'free') {
  return env.SETTLEMENT.get(env.SETTLEMENT.idFromName(settlementName(roundId, mode)));
}

/** Fakes for applyFree's and refundFree's DO calls, recording what they were given. */
export function recordedDeps() {
  const results: { roundId: string; result: ModeResult }[] = [];
  const manifests: AnchorManifestItem[] = [];
  const deps: FreeApplyDeps = {
    notifyRound: (_env, roundId, result) => {
      results.push({ roundId, result });
      return Promise.resolve();
    },
    anchorManifest: (_env, item) => {
      manifests.push(item);
      return Promise.resolve();
    },
  };
  return { deps, results, manifests };
}

export interface Harness {
  stub: DurableObjectStub<SettlementDO>;
  applied: TallyResult[];
  sent: DecryptMessage[];
  /** `apply: 'real'`: the RoundDO results and manifest items the real hooks handed out. */
  calls: ReturnType<typeof recordedDeps>;
  start(): Promise<SettlementStatus>;
  /** Runs the pending alarm; returns the status after it. */
  alarm(): Promise<SettlementStatus>;
  /** Delivers recorded decrypt messages to the real consumer (all of them by default). */
  deliver(messages?: DecryptMessage[]): Promise<void>;
  /** start → prepare → deliver → reduce/apply. */
  run(order?: (sent: DecryptMessage[]) => DecryptMessage[]): Promise<SettlementStatus>;
}

/**
 * A SettlementDO for the round with manual alarms, the fake relays, small chunks, and an applyFree
 * that records its TallyResult. `apply: 'real'` runs the real applyFree and refundFree with
 * recorded DO calls (`calls`); the TallyResult is still recorded.
 */
export async function harness(
  roundId: string,
  opts: {
    relays?: ReturnType<typeof fakeRelays>;
    sizes?: { decrypt: number; bundle: number };
    apply?: 'record' | 'real';
    /** Wipes the DO's storage first: a fresh run of the same (round, mode). */
    fresh?: boolean;
    mode?: Mode;
    /** Stakes: stand in for W6-A's safe-head flag. */
    safeHead?: boolean;
  } = {},
): Promise<Harness> {
  const mode = opts.mode ?? 'free';
  const stub = settlement(roundId, mode);
  const applied: TallyResult[] = [];
  const calls = recordedDeps();
  const sent = recordDecryptQueues();
  const relays = opts.relays ?? fakeRelays(() => 'ok');
  await runInDurableObject(stub, async (o: SettlementDO, state) => {
    if (opts.fresh) {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
      Reflect.set(o, 'job', undefined);
    }
    o.manualAlarms = true;
    o.relayFetch = relays.fetch;
    o.chunkSizes = opts.sizes ?? { decrypt: 4, bundle: 8 };
    const record = (_env: unknown, result: TallyResult) => {
      applied.push(result);
      return Promise.resolve();
    };
    if (opts.apply === 'real') {
      o.hooks = {
        ...o.hooks,
        applyFree: (e, result) => {
          applied.push(result);
          return applyFree(e, result, calls.deps);
        },
        refundFree: (e, id, reason) => refundFree(e, id, reason, calls.deps),
      };
    } else {
      o.hooks = { ...o.hooks, applyFree: record, applyStakes: record };
    }
    if (opts.safeHead !== undefined) {
      const ready = opts.safeHead;
      o.hooks = { ...o.hooks, safeHeadReady: () => Promise.resolve(ready) };
    }
  });
  const h: Harness = {
    stub,
    applied,
    sent,
    calls,
    start: async () =>
      (await stub.start({ roundId, mode, idempotencyKey: `${roundId}:${mode}` })).status,
    alarm: async () => {
      await runDurableObjectAlarm(stub);
      return stub.status();
    },
    deliver: async (messages = sent) => {
      for (const m of messages) await decryptHandler(m, env);
    },
    run: async (order = (s) => s) => {
      await h.start();
      await h.alarm();
      await h.deliver(order([...sent]));
      return h.alarm();
    },
  };
  return h;
}

/** Every bundle object of the round, key → bytes. */
export async function bundleObjects(roundId: string): Promise<Map<string, Uint8Array>> {
  const listed = await env.BUCKET.list({ prefix: `bundles/${roundId}/free/` });
  const out = new Map<string, Uint8Array>();
  for (const o of listed.objects) {
    const obj = await env.BUCKET.get(o.key);
    if (obj) out.set(o.key, new Uint8Array(await obj.arrayBuffer()));
  }
  return out;
}
