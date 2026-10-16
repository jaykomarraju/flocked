// The per-poll Workers budget (I11). One IndexerDO poll (an alarm or a poll() call) is one
// invocation, and a Workers Paid invocation makes at most 1,000 subrequests, D1 queries included
// (D1's own limit is 1,000 queries per invocation). This counts what a poll costs in its worst cases
// (RPC calls, D1 calls and the statements inside batches, Durable Object calls) through counting
// wrappers around the scripted chain, D1 and the RoundDO namespace, and holds the sum to POLL_BUDGET,
// well under the limit.
//
// Measured at W4-F1 (DISPATCH_LIMIT 25, INDEX_RPC_BUDGET 120, MAX_CHANGES_PER_POLL 250): indexing at
// most 146 calls (122 RPC + 24 D1; 244 statements in the widest case), a fork point after a deep
// reorg 21; dispatch at most 227 (about 9 per entry, counting one RoundDO call each); a whole poll
// 374 calls, or 642 counting every batched statement as a query.
import { env } from 'cloudflare:test';
import { newUlid, roundKey } from '@flocked/shared';
import type { Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import {
  INDEX_RPC_BUDGET,
  indexOnce,
  MAX_CHANGES_PER_POLL,
  type IndexOptions,
} from '../../src/indexer/core.js';
import { DISPATCH_LIMIT, dispatchPending } from '../../src/indexer/dispatch.js';
import { handlers } from '../../src/indexer/handlers.js';
import { CREATE2_FACTORY, REFUND_REASON_VOIDED } from '../../src/indexer/policy.js';
import { recordSentTx } from '../../src/indexer/sent.js';
import { seedFixture, type Fixture } from '../helpers/index.js';
import {
  anchorEvent,
  captureAlerts,
  escrowEvent,
  FakeChain,
  hash32,
  lockedLog,
  useDeployment,
} from './helpers.js';

/** What a whole poll may spend (RPC + D1 calls + DO calls): half the limit. */
const POLL_BUDGET = 500;
/** The same, counting every statement inside a D1 batch as its own query (the strictest reading). */
const POLL_BUDGET_STATEMENTS = 800;
/** The DO's queries outside indexOnce and dispatchPending (fastPollWindow for the next alarm). */
const DO_OVERHEAD = 1;

let seed = 500;
let chain: FakeChain;
let dep: ReturnType<typeof useDeployment>;
let fixture: Fixture;

interface Counts {
  d1Calls: number;
  d1Statements: number;
  doCalls: number;
}

/** env with DB and ROUND wrapped to count calls (a batch is one call of several statements). */
function countingEnv(): { env: Env; n: Counts } {
  const n: Counts = { d1Calls: 0, d1Statements: 0, doCalls: 0 };
  const real = new WeakMap<object, D1PreparedStatement>();
  const one = <T>(f: () => Promise<T>) => {
    n.d1Calls++;
    n.d1Statements++;
    return f();
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...v: unknown[]) => wrap(s.bind(...v)),
      first: (col?: string) => one(() => (col === undefined ? s.first() : s.first(col))),
      all: () => one(() => s.all()),
      run: () => one(() => s.run()),
      raw: () => one(() => s.raw()),
    } as unknown as D1PreparedStatement;
    real.set(w, s);
    return w;
  };
  const db = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql)),
    batch: (stmts: D1PreparedStatement[]) => {
      n.d1Calls++;
      n.d1Statements += stmts.length;
      return env.DB.batch(stmts.map((s) => real.get(s) ?? s));
    },
  } as unknown as D1Database;
  const round = {
    idFromName: (name: string) => env.ROUND.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = env.ROUND.get(id);
      return new Proxy(stub, {
        get(target, prop) {
          const v = Reflect.get(target, prop) as unknown;
          if (typeof v !== 'function' || typeof prop !== 'string') return v;
          // An RPC stub's methods are themselves proxies: call through the stub, never .apply.
          const methods = target as unknown as Record<string, (...a: unknown[]) => unknown>;
          return (...args: unknown[]) => {
            n.doCalls++;
            return methods[prop]!(...args);
          };
        },
      });
    },
  } as unknown as Env['ROUND'];
  return { env: { ...env, DB: db, ROUND: round }, n };
}

const index = (db: D1Database, o: Partial<IndexOptions> = {}) =>
  indexOnce({
    db,
    rpc: chain,
    chainId: dep.chainId,
    targets: dep.targets,
    nowMs: Date.now(),
    ...o,
  });

/** Indexes everything (uncounted) so a dispatch can be measured on its own. */
async function indexAll() {
  for (let i = 0; i < 50; i++) {
    const r = await index(env.DB);
    if (r.toBlock >= chain.headNumber) return;
  }
  throw new Error('did not catch up');
}

/** One dispatch call's cost through the default registry (built-in + lifecycle handlers). */
async function measureDispatch() {
  const c = countingEnv();
  const before = chain.totalCalls;
  const r = await dispatchPending(c.env, handlers, {
    chainId: dep.chainId,
    targets: dep.targets,
    rpc: chain,
    nowMs: Date.now(),
  });
  return { r, rpc: chain.totalCalls - before, ...c.n };
}

/** A Free round whose lock is on chain, so Committed events take the full confirmation path. */
async function freeRoundWithLock(): Promise<{ key: Hex }> {
  const id = fixture.ids.round;
  const key = roundKey(id, 'free');
  const closesAtSec = fixture.round.closesAt / 1000;
  const lockTx = chain.newTxHash();
  await recordSentTx(env, { chainId: dep.chainId, txHash: lockTx, kind: 'lock', roundKey: key });
  chain.mine([
    {
      ...anchorEvent(dep.anchor, 'Locked', {
        roundKey: key,
        closesAt: BigInt(closesAtSec),
        beaconRound: 1n,
        questionHash: hash32('q'),
        configHash: hash32('c'),
      }),
      txHash: lockTx,
    },
  ]);
  await indexAll();
  await dispatchPending(env, handlers, {
    chainId: dep.chainId,
    targets: dep.targets,
    rpc: chain,
    nowMs: Date.now(),
  });
  return { key };
}

interface Cost {
  rpc: number;
  d1Calls: number;
  d1Statements: number;
  doCalls: number;
}
const measured: Record<string, Cost> = {};
/** One dispatch call with a Stakes final whose stats hook meets a 7-day backlog (W8-F1 L5). */
let stakesFinal: Cost | undefined;
const calls = (c: Cost) => c.rpc + c.d1Calls + c.doCalls;
const statements = (c: Cost) => c.rpc + c.d1Statements + c.doCalls;

beforeAll(async () => {
  fixture = await seedFixture(env.DB);
});
beforeEach(() => {
  captureAlerts();
  chain = new FakeChain();
  dep = useDeployment(seed++);
  // Our contracts have code from block 1, so factory-shaped transactions take the code lookup.
  chain.deployedAt.set(dep.escrow, 1);
  chain.deployedAt.set(dep.anchor, 1);
});
afterEach(() => vi.restoreAllMocks());

describe('the per-poll budget (Workers: 1,000 subrequests per invocation)', () => {
  it('an indexing poll: a 10-block provider with a log in every block', async () => {
    for (let i = 0; i < 1_500; i++) {
      chain.mine([
        lockedLog(dep.anchor, i),
        escrowEvent(dep.escrow, 'Withdrawn', { account: `0x${'11'.repeat(20)}`, amount: 1n }),
      ]);
    }
    chain.maxLogRange = 10;
    const c = countingEnv();
    const before = chain.totalCalls;
    const r = await index(c.env.DB, { range: { maxRange: 10 } });
    const rpc = chain.totalCalls - before;
    expect(r.toBlock).toBeGreaterThan(0);
    expect(r.rpcCalls).toBe(rpc);
    expect(rpc).toBeLessThanOrEqual(INDEX_RPC_BUDGET + 8);
    expect(r.changes).toBeLessThanOrEqual(MAX_CHANGES_PER_POLL + 2);
    measured.indexNarrow = { rpc, ...c.n };
  });

  it('an indexing poll: a wide provider with a log in every block (each block is verified)', async () => {
    for (let i = 0; i < 1_500; i++) {
      chain.mine([lockedLog(dep.anchor, i), lockedLog(dep.anchor, i + 10_000)]);
    }
    const c = countingEnv();
    const before = chain.totalCalls;
    const r = await index(c.env.DB);
    const rpc = chain.totalCalls - before;
    expect(r.toBlock).toBeGreaterThan(0);
    expect(rpc).toBeLessThanOrEqual(INDEX_RPC_BUDGET + 8);
    expect(r.changes).toBeLessThanOrEqual(MAX_CHANGES_PER_POLL + 2);
    measured.indexWide = { rpc, ...c.n };
  });

  it('an indexing poll after a deep reorg: the fork point costs a handful of reads', async () => {
    for (let i = 0; i < 40; i++) {
      chain.mineEmpty(1);
      await index(env.DB); // checkpoints at blocks 9..40
    }
    chain.reorg(21); // blocks 20..40 replaced
    chain.mineEmpty(25);
    const c = countingEnv();
    const before = chain.totalCalls;
    const r = await index(c.env.DB);
    const rpc = chain.totalCalls - before;
    expect(r.reorg).toBe(true);
    expect(r.contracts.map((x) => x.fromBlock)).toEqual([20, 20]); // from checkpoint 19
    // Per contract: the stored-position check, the probes (gallop + bisect), one chunk to the head.
    expect(rpc).toBeLessThanOrEqual(1 + 2 * (1 + 16 + 2));
    measured.indexReorg = { rpc, ...c.n };
  });

  it(`a dispatch call: ${DISPATCH_LIMIT} entries of the costliest kinds`, async () => {
    const { key } = await freeRoundWithLock();
    // Foreign Committed events through the CREATE2 factory: ALERT-8 reads sent_txs, the transaction
    // and the code; the confirmation handler finds the round and compares the root.
    for (let i = 0; i < DISPATCH_LIMIT; i++) {
      chain.mine(
        [
          anchorEvent(dep.anchor, 'Committed', {
            roundKey: key,
            commitmentRoot: hash32(`root-${i}`),
            entryCount: 1,
            totalStake: 0n,
          }),
        ],
        { to: CREATE2_FACTORY },
      );
    }
    await indexAll();
    const committed = await measureDispatch();
    expect(committed.r).toMatchObject({ dispatched: DISPATCH_LIMIT, failed: null });

    // Foreign voids (RoundRefunded reason 4): ALERT-8, then the void handler tells the RoundDO.
    for (let i = 0; i < DISPATCH_LIMIT; i++) {
      chain.mine(
        [escrowEvent(dep.escrow, 'RoundRefunded', { roundId: 1n, reason: REFUND_REASON_VOIDED })],
        { to: CREATE2_FACTORY },
      );
    }
    await indexAll();
    const voids = await measureDispatch();
    expect(voids.r).toMatchObject({ dispatched: DISPATCH_LIMIT, failed: null });

    // Entered (foreign: no ticket) for a known round: both Entered handlers resolve the entry.
    for (let i = 0; i < DISPATCH_LIMIT; i++) {
      chain.mine([
        escrowEvent(dep.escrow, 'Entered', {
          roundId: 1n,
          player: `0x${'44'.repeat(20)}`,
          personTag: hash32(`person-${i}`),
          ticketHash: hash32(`ticket-${i}`),
          ciphertext: '0x01',
        }),
      ]);
    }
    await indexAll();
    const entered = await measureDispatch();
    expect(entered.r).toMatchObject({ dispatched: DISPATCH_LIMIT, failed: null });

    // A ticketed Entered also calls the RoundDO once (stakesIngestHandler): one more per entry.
    for (const [name, m] of Object.entries({ committed, voids, entered })) {
      const { rpc, d1Calls, d1Statements, doCalls } = m;
      measured[`dispatch:${name}`] = {
        rpc,
        d1Calls,
        d1Statements,
        doCalls: doCalls + DISPATCH_LIMIT,
      };
    }
  });

  it('a dispatch call: a Stakes final whose stats hook meets a 7-day backlog (W8-F1 L5)', async () => {
    // Seven Stakes days closing in 2001, before every other round here. Day 1 was held (a settled
    // proposal awaiting RoundFinalized, 3 entrants); days 2–7 settled meanwhile, 5,000 entrants each.
    // RoundFinalized for day 1 runs the stats hook, which may now apply all seven days in order.
    const ENTRANTS = 5_000;
    const STAKE = 1_000_000;
    const db = env.DB;
    for (let d = 1; d <= 7; d++) {
      const roundId = newUlid();
      const closesAt = 1_000_000_000_000 + d * 86_400_000;
      const held = d === 1;
      const bundleHash = hash32(`backlog-bundle-${d}`);
      await db.batch([
        db
          .prepare(
            `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json)
             VALUES (?1, 'daily', NULL, ?2, ?3, ?4, 1, 'closed', 1, '{}')`,
          )
          .bind(roundId, newUlid(), closesAt - 86_400_000, closesAt),
        db
          .prepare(
            `INSERT INTO round_modes (round_id, mode, status, chain_round_id, bundle_hash, revealed_at,
               claims_open_at, final_at)
             VALUES (?1, 'stakes', ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(
            roundId,
            held ? 'settle_proposed' : 'settled',
            String(9_000 + d),
            bundleHash,
            closesAt + 60_000,
            closesAt + 7_200_000,
            held ? null : closesAt + 7_200_000,
          ),
        db
          .prepare(
            `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json,
               winners_json, payout_root, bundle_hash)
             VALUES (?1, 'stakes', 0, 'settled', 1, ?2, ?3, ?4, ?5)`,
          )
          .bind(
            roundId,
            JSON.stringify([
              { headcount: 1, total: String(STAKE) },
              { headcount: 2, total: String(2 * STAKE) },
            ]),
            JSON.stringify({
              winner: 0,
              refundReason: null,
              winPayout: '2850000',
              rebatePayout: '10000',
            }),
            hash32(`backlog-root-${d}`),
            bundleHash,
          ),
        db
          .prepare(
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
             INSERT INTO entries (id, round_id, mode, user_id, foreign_entry, wallet, person_tag, stake,
               commitment, tx_hash, block_number, log_index, option_index, valid, created_at)
             SELECT printf('E%d-%06d', ?3, i), ?1, 'stakes', printf('U%06d', i), 0, printf('0x%040x', i),
               printf('0x%064x', ?3 * 1000000 + i), ?4, printf('0x%064x', ?3 * 1000000 + i),
               printf('0x%064x', ?3 * 1000000 + i), i, 0, CASE WHEN i = 1 THEN 0 ELSE 1 END, 1, 1
             FROM n`,
          )
          .bind(roundId, held ? 3 : ENTRANTS, d, STAKE),
      ]);
    }
    chain.mine([escrowEvent(dep.escrow, 'RoundFinalized', { roundId: 9_001n, status: 4 })]);
    await indexAll();
    const final = await measureDispatch();
    expect(final.r).toMatchObject({ dispatched: 1, failed: null });
    // The hook applied the held day, so the stats moved (how far is the budget's business).
    const days = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM stats_days WHERE mode = 'stakes' AND done_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(days?.n).toBeGreaterThanOrEqual(1);
    const { rpc, d1Calls, d1Statements, doCalls } = final;
    stakesFinal = { rpc, d1Calls, d1Statements, doCalls };
  });

  it('a whole poll stays inside POLL_BUDGET', () => {
    const all = Object.entries(measured);
    const worst = (prefix: string, f: (c: Cost) => number) =>
      Math.max(...all.filter(([k]) => k.startsWith(prefix)).map(([, c]) => f(c)));
    expect(all).toHaveLength(6);
    // A Stakes final among the dispatched entries adds its stats hook's work (W8-F1 L5), counted on
    // top of a full dispatch of the costliest kinds.
    expect(stakesFinal).toBeDefined();
    const final = stakesFinal as Cost;
    const total = worst('index', calls) + worst('dispatch', calls) + calls(final) + DO_OVERHEAD;
    const strict =
      worst('index', statements) + worst('dispatch', statements) + statements(final) + DO_OVERHEAD;
    expect(total).toBeLessThanOrEqual(POLL_BUDGET);
    expect(strict).toBeLessThanOrEqual(POLL_BUDGET_STATEMENTS);
  });
});
