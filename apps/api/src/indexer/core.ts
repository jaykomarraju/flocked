// Indexer core: range polling, reorg detection and the chain_events diff (spec "Architecture": Chain
// indexer; "Data model" indexer_state: if the stored hash no longer matches the chain, re-index from
// 5 blocks back). It imports nothing Workers-only, so the e2e stack test runs it in Node.
//
// Each poll, per contract: check the stored last block's hash. On a mismatch, rewind to the newest
// checkpoint (indexer_checkpoints: every position the indexer has stored) at or below REORG_DEPTH
// blocks back that is still canonical, or to the deploy block when none is. Then scan forward in
// chunks the provider accepts, applying each chunk as it arrives: one D1 batch writes the chunk's
// diff against chain_events (a stored log the scan no longer has becomes removed = 1; a new, returning
// or changed log is upserted; an unchanged one is left alone) together with indexer_state and a
// checkpoint at the chunk's end, so a crash keeps every chunk already applied and nothing past it.
//
// Consistency: a chunk's end hash is read before its logs, and every block that has a log is read
// and must match the log's blockHash (a provider behind a load balancer can serve logs from a stale
// node). The position a chunk starts from is read again after the chunk's logs unless the chunk ends
// at the poll's head (read before anything else), so a stored hash is never newer than the data under
// it: a reorg in between is caught here (the scan stops) or by the next poll's hash check.
//
// A poll stays inside an RPC and a write budget (Workers limits: one IndexerDO invocation makes at
// most 1,000 subrequests, D1 queries included; test/indexer/budget.test.ts measures a whole poll).
// Nothing here calls handlers; the dispatcher (dispatch.ts) works through what changed.
import type { Hex } from 'viem';
import { log } from '../lib/log.js';
import { argsJson, decodeLog } from './decode.js';
import { isLogRangeError } from './rpc.js';
import type { IndexerRpc, IndexerTarget, RpcBlock, RpcLog } from './types.js';

/** Blocks to re-index when the stored hash no longer matches (spec "Data model" indexer_state). */
export const REORG_DEPTH = 5;
/** Starting (and largest) eth_getLogs block range; halved when a provider rejects a range. */
export const MAX_LOG_RANGE = 2_000;
/** Full-size ranges accepted in a row before a reduced range doubles again. */
export const LOG_RANGE_REGROW_AFTER = 8;
/** Blocks scanned per contract per poll; a longer catch-up continues on the next poll. */
export const MAX_BLOCKS_PER_POLL = 10_000;
/**
 * RPC calls per poll, all contracts together. Once spent, no new chunk starts (each contract's first
 * chunk always runs, so a poll always makes progress) and a chunk stops at the last log block it
 * could still verify.
 */
export const INDEX_RPC_BUDGET = 120;
/** chain_events writes (upserts and removals) per poll; a chunk stops at a log block to stay under. */
export const MAX_CHANGES_PER_POLL = 250;
/** Checkpoints kept per contract: the newest CHECKPOINTS_RECENT, plus the newest per bucket. */
export const CHECKPOINTS_RECENT = 32;
const CHECKPOINT_BUCKET = 1_024;
const CHECKPOINT_BUCKETS = 64;
const CHECKPOINTS_MAX = CHECKPOINTS_RECENT + CHECKPOINT_BUCKETS;

/** The chain moved under a scan (a log's block hash differs from the block fetched for it). */
export class ReorgDuringScanError extends Error {
  constructor(blockNumber: number) {
    super(`block ${blockNumber} changed during the scan`);
    this.name = 'ReorgDuringScanError';
  }
}

export interface IndexState {
  lastBlockNumber: number;
  lastBlockHash: Hex;
  updatedAt: number;
}

export interface ContractPollResult {
  target: IndexerTarget;
  /** First block scanned; toBlock + 1 when there was nothing to scan. */
  fromBlock: number;
  /** Last block indexed (the stored position after this poll). */
  toBlock: number;
  /** Logs in the applied chunks. */
  events: number;
  reorg: boolean;
  /** Timestamp of toBlock, Unix seconds. */
  indexedTimestamp: number;
}

export interface IndexOnceResult {
  head: RpcBlock;
  contracts: ContractPollResult[];
  fromBlock: number;
  toBlock: number;
  events: number;
  reorg: boolean;
  /** Head timestamp minus the oldest indexed position's timestamp, seconds. */
  lagSec: number;
  /** RPC calls this poll made, and chain_events writes it applied (the per-poll budget). */
  rpcCalls: number;
  changes: number;
}

/** A provider's learned eth_getLogs range limit, kept across polls by the caller. */
export interface LogRange {
  maxRange: number;
  /** Full-size ranges accepted in a row at a reduced maxRange (it doubles at LOG_RANGE_REGROW_AFTER). */
  accepted?: number;
}

export interface IndexOptions {
  db: D1Database;
  rpc: IndexerRpc;
  chainId: number;
  targets: IndexerTarget[];
  nowMs: number;
  range?: LogRange;
  maxBlocksPerPoll?: number;
  rpcBudget?: number;
  maxChangesPerPoll?: number;
}

export async function readIndexState(
  db: D1Database,
  chainId: number,
  contract: Hex,
): Promise<IndexState | null> {
  const row = await db
    .prepare(
      'SELECT last_block_number, last_block_hash, updated_at FROM indexer_state WHERE chain_id = ?1 AND contract = ?2',
    )
    .bind(chainId, contract)
    .first<{ last_block_number: number; last_block_hash: string; updated_at: number }>();
  return row
    ? {
        lastBlockNumber: row.last_block_number,
        lastBlockHash: row.last_block_hash as Hex,
        updatedAt: row.updated_at,
      }
    : null;
}

/** One poll's view of the chain: the head, every block fetched (each read once), and the budget. */
class PollContext {
  private readonly blocks = new Map<number, Promise<RpcBlock | null>>();
  readonly range: LogRange;
  readonly maxBlocks: number;
  readonly rpcBudget: number;
  readonly maxChanges: number;
  /** RPC calls so far; the head is the first. */
  rpcCalls = 1;
  /** chain_events writes so far. */
  changes = 0;

  constructor(
    readonly o: IndexOptions,
    readonly head: RpcBlock,
  ) {
    this.blocks.set(head.number, Promise.resolve(head));
    this.range = o.range ?? { maxRange: MAX_LOG_RANGE };
    this.maxBlocks = o.maxBlocksPerPoll ?? MAX_BLOCKS_PER_POLL;
    this.rpcBudget = o.rpcBudget ?? INDEX_RPC_BUDGET;
    this.maxChanges = o.maxChangesPerPoll ?? MAX_CHANGES_PER_POLL;
  }

  isCached(n: number): boolean {
    return this.blocks.has(n);
  }

  block(n: number): Promise<RpcBlock | null> {
    let b = this.blocks.get(n);
    if (!b) {
      this.rpcCalls++;
      b = this.o.rpc.block(n);
      this.blocks.set(n, b);
    }
    return b;
  }

  async canonical(n: number): Promise<RpcBlock> {
    const b = await this.block(n);
    if (!b) throw new Error(`rpc has no block ${n} (head ${this.head.number})`);
    return b;
  }

  /** Reads a block again, past the cache (the chunk-start check). */
  fresh(n: number): Promise<RpcBlock | null> {
    this.rpcCalls++;
    return this.o.rpc.block(n);
  }

  logs(address: Hex, from: number, to: number): Promise<RpcLog[]> {
    this.rpcCalls++;
    return this.o.rpc.logs(address, from, to);
  }

  rpcLeft(): number {
    return this.rpcBudget - this.rpcCalls;
  }

  changesLeft(): number {
    return this.maxChanges - this.changes;
  }
}

/**
 * Polls every target once. Throws on an RPC failure; chunks applied before it stay applied (each is
 * one D1 batch with its indexer_state), so the next poll continues from there.
 */
export async function indexOnce(o: IndexOptions): Promise<IndexOnceResult> {
  const head = await o.rpc.head();
  const p = new PollContext(o, head);
  const contracts: ContractPollResult[] = [];
  for (const t of o.targets) contracts.push(await indexContract(p, t));
  const indexed = Math.min(head.timestamp, ...contracts.map((c) => c.indexedTimestamp));
  return {
    head,
    contracts,
    fromBlock: Math.min(...contracts.map((c) => c.fromBlock)),
    toBlock: Math.max(...contracts.map((c) => c.toBlock)),
    events: contracts.reduce((n, c) => n + c.events, 0),
    reorg: contracts.some((c) => c.reorg),
    lagSec: Math.max(0, head.timestamp - indexed),
    rpcCalls: p.rpcCalls,
    changes: p.changes,
  };
}

/** A position: a block and the hash stored for it (null for the floor below the deploy block). */
interface Position {
  number: number;
  hash: Hex | null;
}

async function indexContract(p: PollContext, t: IndexerTarget): Promise<ContractPollResult> {
  const { db, chainId } = p.o;
  const state = await readIndexState(db, chainId, t.address);
  let start: Position = { number: t.startBlock - 1, hash: null };
  let reorg = false;
  if (state) {
    if (p.head.number < state.lastBlockNumber) {
      // The provider is behind what is already indexed (a lagging fallback, or an anvil revert
      // that hasn't been re-mined past it). Wait for it rather than treating it as a reorg.
      log.warn('indexer_rpc_behind', {
        chainId,
        contract: t.address,
        head: p.head.number,
        lastBlock: state.lastBlockNumber,
      });
      return {
        target: t,
        fromBlock: state.lastBlockNumber + 1,
        toBlock: state.lastBlockNumber,
        events: 0,
        reorg: false,
        indexedTimestamp: p.head.timestamp,
      };
    }
    const stored = await p.canonical(state.lastBlockNumber);
    if (stored.hash === state.lastBlockHash) {
      start = { number: state.lastBlockNumber, hash: state.lastBlockHash };
    } else {
      reorg = true;
      start = await forkPoint(p, t, state.lastBlockNumber);
      log.warn('indexer_reorg', {
        chainId,
        contract: t.address,
        lastBlock: state.lastBlockNumber,
        storedHash: state.lastBlockHash,
        chainHash: stored.hash,
        rewindTo: start.number,
      });
    }
  }

  const target = Math.min(p.head.number, start.number + p.maxBlocks);
  let pos = start;
  let posTimestamp: number | null = null;
  let events = 0;
  let applied = 0;
  // A rejected range only halves maxRange, so the loop ends: each pass applies a chunk or shrinks it.
  while (pos.number < target) {
    if (applied > 0 && (p.rpcLeft() <= 0 || p.changesLeft() <= 0)) break;
    let chunk: AppliedChunk | null;
    try {
      chunk = await scanChunk(p, t, pos, target, reorg && applied === 0);
    } catch (err) {
      if (!(err instanceof ReorgDuringScanError)) throw err;
      // Nothing of this chunk was written; the next poll's hash check finds the fork.
      log.warn('indexer_reorg_during_scan', {
        chainId,
        contract: t.address,
        at: pos.number,
        error: err.message,
      });
      reorg = true;
      break;
    }
    if (chunk === null) continue;
    applied++;
    events += chunk.events;
    pos = { number: chunk.end.number, hash: chunk.end.hash };
    posTimestamp = chunk.end.timestamp;
  }
  if (posTimestamp === null) {
    posTimestamp =
      pos.number === p.head.number || pos.number < 0
        ? p.head.timestamp
        : (await p.canonical(pos.number)).timestamp;
  }
  return {
    target: t,
    fromBlock: start.number + 1,
    toBlock: pos.number,
    events,
    reorg,
    indexedTimestamp: posTimestamp,
  };
}

/**
 * Where to re-index from after a hash mismatch at `last`: the newest checkpoint at or below
 * REORG_DEPTH blocks back whose hash is still canonical (every block up to it is then unchanged). It
 * gallops back through the checkpoints (the newest, 2nd, 4th, 8th, ..., oldest) to a canonical one,
 * then bisects the gap, so even a deep reorg costs a handful of block reads. With no canonical
 * checkpoint, the floor (the whole deployment is re-indexed, a chunk at a time).
 */
async function forkPoint(p: PollContext, t: IndexerTarget, last: number): Promise<Position> {
  const floor: Position = { number: t.startBlock - 1, hash: null };
  const candidate = last - REORG_DEPTH;
  if (candidate <= floor.number) return floor;
  const { results: probes } = await p.o.db
    .prepare(
      `SELECT block_number, block_hash FROM indexer_checkpoints
       WHERE chain_id = ?1 AND contract = ?2 AND block_number > ?3 AND block_number <= ?4
       ORDER BY block_number DESC LIMIT ${CHECKPOINTS_MAX}`,
    )
    .bind(p.o.chainId, t.address, floor.number, candidate)
    .all<{ block_number: number; block_hash: string }>();
  const canonical = async (i: number) =>
    (await p.block(probes[i]!.block_number))?.hash === probes[i]!.block_hash;

  let bad = -1;
  let good = -1;
  for (let i = 0; i < probes.length; i = Math.min(probes.length - 1, 2 * i + 1)) {
    if (await canonical(i)) {
      good = i;
      break;
    }
    bad = i;
    if (i === probes.length - 1) break;
  }
  if (good < 0) {
    const detail = { chainId: p.o.chainId, contract: t.address, last, checkpoints: probes.length };
    if (probes.length > 0) log.error('indexer_deep_reorg', detail);
    else log.warn('indexer_reorg_no_checkpoint', detail);
    return floor;
  }
  while (good - bad > 1) {
    const mid = (good + bad) >> 1;
    if (await canonical(mid)) good = mid;
    else bad = mid;
  }
  return { number: probes[good]!.block_number, hash: probes[good]!.block_hash as Hex };
}

interface AppliedChunk {
  end: RpcBlock;
  events: number;
}

interface StoredRow {
  tx_hash: string;
  log_index: number;
  contract: string;
  block_number: number;
  block_hash: string;
  block_timestamp: number;
  event: string;
  args_json: string;
  removed: number;
}

const key = (txHash: string, logIndex: number) => `${txHash}:${logIndex}`;

/**
 * Scans and applies one chunk after `pos`: up to maxRange blocks, cut short at a log block when the
 * poll's RPC or write budget runs out. Returns null when the provider rejected the range as too large
 * (maxRange is halved; the caller tries again).
 * @throws ReorgDuringScanError when a block changed under the scan (nothing of the chunk is written).
 */
async function scanChunk(
  p: PollContext,
  t: IndexerTarget,
  pos: Position,
  target: number,
  afterReorg: boolean,
): Promise<AppliedChunk | null> {
  const want = Math.min(target, pos.number + p.range.maxRange);
  // The end hash is read before the logs: if the chain reorgs in between, the stored hash is the old
  // one and the next poll sees the mismatch. (Read after, stale logs could look current.)
  let end = await p.canonical(want);
  let logs: RpcLog[];
  try {
    logs = await p.logs(t.address, pos.number + 1, want);
  } catch (err) {
    if (want > pos.number + 1 && isLogRangeError(err)) {
      p.range.maxRange = Math.max(1, Math.floor((want - pos.number) / 2));
      p.range.accepted = 0;
      log.warn('indexer_log_range_reduced', { maxRange: p.range.maxRange });
      return null;
    }
    throw err;
  }
  // A reduced range (a transient timeout, or a provider's limit) grows back after a run of successes;
  // if the provider really has the lower limit, the next rejection halves it again.
  if (want - pos.number === p.range.maxRange && p.range.maxRange < MAX_LOG_RANGE) {
    p.range.accepted = (p.range.accepted ?? 0) + 1;
    if (p.range.accepted >= LOG_RANGE_REGROW_AFTER) {
      p.range.maxRange = Math.min(MAX_LOG_RANGE, p.range.maxRange * 2);
      p.range.accepted = 0;
      log.info('indexer_log_range_grown', { maxRange: p.range.maxRange });
    }
  }
  logs = logs
    .filter((l) => l.address === t.address && l.blockNumber > pos.number && l.blockNumber <= want)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  // Every block with a log must be the canonical block the log names. Stop at the last one the RPC
  // budget covers (always at least one): a verified log block commits the chain up to it, so it can
  // stand in for the chunk's end.
  const logBlocks = [...new Set(logs.map((l) => l.blockNumber))];
  const verified: RpcBlock[] = [];
  for (const n of logBlocks) {
    if (verified.length > 0 && !p.isCached(n) && p.rpcLeft() <= 0) break;
    const b = await p.canonical(n);
    for (const l of logs) {
      if (l.blockNumber === n && l.blockHash !== b.hash) throw new ReorgDuringScanError(n);
    }
    verified.push(b);
  }
  if (verified.length < logBlocks.length) end = verified[verified.length - 1]!;

  const { db, chainId, nowMs } = p.o;
  const { results: stored } = await db
    .prepare(
      `SELECT tx_hash, log_index, contract, block_number, block_hash, block_timestamp, event, args_json,
              removed
       FROM chain_events WHERE chain_id = ?1 AND contract = ?2 AND block_number > ?3 AND block_number <= ?4`,
    )
    .bind(chainId, t.address, pos.number, end.number)
    .all<StoredRow>();
  const timestamps = new Map(verified.map((b) => [b.number, b.timestamp]));

  /** The writes for (pos, upTo], keyed by block: new or changed logs, and stored logs now gone. */
  const diff = (upTo: number): [number, D1PreparedStatement][] => {
    const byKey = new Map(stored.map((r) => [key(r.tx_hash, r.log_index), r]));
    const out: [number, D1PreparedStatement][] = [];
    const scanned = new Set<string>();
    for (const l of logs) {
      if (l.blockNumber > upTo) break;
      const k = key(l.transactionHash, l.logIndex);
      scanned.add(k);
      const { event, args } = decodeLog(t.abi, l);
      const json = argsJson(args);
      const ts = timestamps.get(l.blockNumber)!;
      const s = byKey.get(k);
      if (
        s?.removed === 0 &&
        s.contract === t.address &&
        s.block_number === l.blockNumber &&
        s.block_hash === l.blockHash &&
        s.block_timestamp === ts &&
        s.event === event &&
        s.args_json === json
      ) {
        continue;
      }
      const bind = [chainId, t.address, l.blockNumber, l.blockHash, ts, l.transactionHash];
      out.push([
        l.blockNumber,
        db.prepare(UPSERT_EVENT).bind(...bind, l.logIndex, event, json, nowMs),
      ]);
    }
    for (const r of stored) {
      if (r.block_number <= upTo && r.removed === 0 && !scanned.has(key(r.tx_hash, r.log_index))) {
        out.push([
          r.block_number,
          db.prepare(MARK_REMOVED).bind(chainId, r.tx_hash, r.log_index, nowMs),
        ]);
      }
    }
    return out;
  };

  let writes = diff(end.number);
  if (writes.length > p.changesLeft()) {
    // Over the write budget: end at the last verified log block that fits (at least the first).
    const costUpTo = (n: number) => writes.filter(([b]) => b <= n).length;
    let cut: RpcBlock | null = null;
    for (const b of verified) {
      if (b.number >= end.number) break;
      if (cut !== null && costUpTo(b.number) > p.changesLeft()) break;
      cut = b;
    }
    if (cut !== null) {
      end = cut;
      writes = diff(end.number);
    }
  }

  // The chunk's start must still be canonical now that its end and logs are read, unless the end is
  // the poll's head (read before any of the data under it).
  if (pos.hash !== null && end.number !== p.head.number) {
    const again = await p.fresh(pos.number);
    if (again?.hash !== pos.hash) throw new ReorgDuringScanError(pos.number);
  }

  const stmts = writes.map(([, s]) => s);
  if (afterReorg) {
    // Checkpoints past the fork point are the old branch's.
    stmts.push(
      db
        .prepare(
          'DELETE FROM indexer_checkpoints WHERE chain_id = ?1 AND contract = ?2 AND block_number > ?3',
        )
        .bind(chainId, t.address, pos.number),
    );
  }
  stmts.push(
    db.prepare(UPSERT_STATE).bind(chainId, t.address, end.number, end.hash, nowMs),
    db.prepare(UPSERT_CHECKPOINT).bind(chainId, t.address, end.number, end.hash, nowMs),
    db.prepare(PRUNE_CHECKPOINTS).bind(chainId, t.address, end.number),
  );
  // One batch: the chunk's events, its position and its checkpoint commit together.
  await db.batch(stmts);
  p.changes += writes.length;
  return { end, events: logs.filter((l) => l.blockNumber <= end.number).length };
}

// A changed log (another event, args, block or contract in the same (tx_hash, log_index) slot) moves
// the row two revisions on: the chain_events_removal trigger (migration 0007) records the old content
// as revision + 1, a removal, and the new content is revision + 2. A returning log is revision + 1
// (its removal was recorded when it left).
const UPSERT_EVENT = `INSERT INTO chain_events
  (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash, log_index, event, args_json,
   removed, revision, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, ?10, ?10)
ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE SET
  contract = excluded.contract,
  block_number = excluded.block_number,
  block_hash = excluded.block_hash,
  block_timestamp = excluded.block_timestamp,
  event = excluded.event,
  args_json = excluded.args_json,
  removed = 0,
  revision = revision + (CASE WHEN removed = 1 THEN 1 ELSE 2 END),
  dispatch_attempts = 0,
  dispatch_error = NULL,
  dispatch_alerted_at = NULL,
  updated_at = excluded.updated_at
WHERE removed = 1 OR contract <> excluded.contract OR block_number <> excluded.block_number
   OR block_hash <> excluded.block_hash OR block_timestamp <> excluded.block_timestamp
   OR event <> excluded.event OR args_json <> excluded.args_json`;

// The trigger records the removal (revision + 1) in chain_event_removals, so the row itself has
// nothing left to dispatch until the log returns.
const MARK_REMOVED = `UPDATE chain_events SET removed = 1, revision = revision + 1,
  dispatched_revision = revision + 1, dispatch_attempts = 0, dispatch_error = NULL,
  dispatch_alerted_at = NULL, updated_at = ?4
WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 AND removed = 0`;

const UPSERT_STATE = `INSERT INTO indexer_state (chain_id, contract, last_block_number, last_block_hash, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (chain_id, contract) DO UPDATE SET last_block_number = excluded.last_block_number,
  last_block_hash = excluded.last_block_hash, updated_at = excluded.updated_at`;

const UPSERT_CHECKPOINT = `INSERT INTO indexer_checkpoints (chain_id, contract, block_number, block_hash, created_at)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (chain_id, contract, block_number) DO UPDATE SET block_hash = excluded.block_hash,
  created_at = excluded.created_at`;

// Keeps the newest CHECKPOINTS_RECENT, plus the newest in each CHECKPOINT_BUCKET-block bucket of the
// last CHECKPOINT_BUCKETS. The constants are inlined: `/` must divide integers, and a bound number
// may arrive as a REAL.
const PRUNE_CHECKPOINTS = `DELETE FROM indexer_checkpoints
WHERE chain_id = ?1 AND contract = ?2
  AND block_number < (SELECT MIN(block_number) FROM (
        SELECT block_number FROM indexer_checkpoints WHERE chain_id = ?1 AND contract = ?2
        ORDER BY block_number DESC LIMIT ${CHECKPOINTS_RECENT}))
  AND (block_number <= ?3 - ${CHECKPOINT_BUCKET * CHECKPOINT_BUCKETS}
       OR block_number NOT IN (
         SELECT MAX(block_number) FROM indexer_checkpoints WHERE chain_id = ?1 AND contract = ?2
         GROUP BY block_number / ${CHECKPOINT_BUCKET}))`;
