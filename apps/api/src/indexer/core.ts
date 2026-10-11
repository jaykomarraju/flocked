// Indexer core: range polling, reorg detection and the chain_events diff (spec "Architecture": Chain
// indexer; "Data model" indexer_state: if the stored hash no longer matches the chain, re-index from
// 5 blocks back). It imports nothing Workers-only, so the e2e stack test runs it in Node.
//
// Each poll, per contract: check the stored last block's hash; on a mismatch rewind REORG_DEPTH blocks
// (further if a stored event's block is no longer canonical). Scan (from, to] in ranges the provider
// accepts, then diff against chain_events: a stored log missing from the scan becomes removed = 1, a
// new or returning log is upserted, an unchanged one is left alone. Nothing here calls handlers; the
// dispatcher (dispatch.ts) works through the rows whose revision some handler hasn't seen.
import type { Hex } from 'viem';
import { log } from '../lib/log.js';
import { argsJson, decodeLog } from './decode.js';
import { isLogRangeError } from './rpc.js';
import type { IndexerRpc, IndexerTarget, RpcBlock, RpcLog } from './types.js';

/** Blocks to re-index when the stored hash no longer matches (spec "Data model" indexer_state). */
export const REORG_DEPTH = 5;
/** Starting eth_getLogs block range; halved whenever a provider rejects a range as too large. */
export const MAX_LOG_RANGE = 2_000;
/** Blocks scanned per contract per poll; a longer catch-up continues on the next poll. */
export const MAX_BLOCKS_PER_POLL = 10_000;
/** Further rewinds allowed when a stored event's block has also changed (a reorg deeper than 5). */
const MAX_REWINDS = 20;
/** D1 statements per batch. */
const BATCH_SIZE = 50;

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
  /** Logs in the scanned range. */
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
}

/** A provider's learned eth_getLogs range limit, kept across polls by the caller. */
export interface LogRange {
  maxRange: number;
}

export interface IndexOptions {
  db: D1Database;
  rpc: IndexerRpc;
  chainId: number;
  targets: IndexerTarget[];
  nowMs: number;
  range?: LogRange;
  maxBlocksPerPoll?: number;
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

/** One poll's view of the chain: the head and every block fetched, so each is read once. */
class PollContext {
  private readonly blocks = new Map<number, Promise<RpcBlock | null>>();
  readonly range: LogRange;
  readonly maxBlocks: number;

  constructor(
    readonly o: IndexOptions,
    readonly head: RpcBlock,
  ) {
    this.blocks.set(head.number, Promise.resolve(head));
    this.range = o.range ?? { maxRange: MAX_LOG_RANGE };
    this.maxBlocks = o.maxBlocksPerPoll ?? MAX_BLOCKS_PER_POLL;
  }

  block(n: number): Promise<RpcBlock | null> {
    let b = this.blocks.get(n);
    if (!b) {
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
}

/** Polls every target once. Throws on an RPC failure; nothing is half-written (see applyRange). */
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
  };
}

async function indexContract(p: PollContext, t: IndexerTarget): Promise<ContractPollResult> {
  const { db, chainId } = p.o;
  const floor = t.startBlock - 1;
  const state = await readIndexState(db, chainId, t.address);
  let from = floor;
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
      from = state.lastBlockNumber;
    } else {
      reorg = true;
      from = await forkPoint(p, t, Math.max(floor, state.lastBlockNumber - REORG_DEPTH));
      log.warn('indexer_reorg', {
        chainId,
        contract: t.address,
        lastBlock: state.lastBlockNumber,
        storedHash: state.lastBlockHash,
        chainHash: stored.hash,
        rewindTo: from,
      });
    }
  }
  const to = Math.min(p.head.number, from + p.maxBlocks);
  if (to <= from) {
    return {
      target: t,
      fromBlock: from + 1,
      toBlock: from,
      events: 0,
      reorg,
      indexedTimestamp: p.head.timestamp,
    };
  }
  // The end block's hash is read before the logs: if the chain reorgs in between, the stored hash is
  // the old one and the next poll sees the mismatch. (Read after, stale logs could look current.)
  const end = await p.canonical(to);
  const logs = await fetchLogs(p, t.address, from + 1, to);
  await applyRange(p, t, from, end, logs);
  return {
    target: t,
    fromBlock: from + 1,
    toBlock: to,
    events: logs.length,
    reorg,
    indexedTimestamp: end.timestamp,
  };
}

/**
 * The block to re-index from after a hash mismatch: REORG_DEPTH back, then further while the newest
 * stored event at or below that point sits in a block that is no longer canonical.
 */
async function forkPoint(p: PollContext, t: IndexerTarget, candidate: number): Promise<number> {
  const floor = t.startBlock - 1;
  for (let i = 0; i < MAX_REWINDS && candidate > floor; i++) {
    const row = await p.o.db
      .prepare(
        'SELECT block_number, block_hash FROM chain_events WHERE chain_id = ?1 AND contract = ?2 AND removed = 0 AND block_number <= ?3 ORDER BY block_number DESC LIMIT 1',
      )
      .bind(p.o.chainId, t.address, candidate)
      .first<{ block_number: number; block_hash: string }>();
    if (!row) return candidate;
    const b = await p.block(row.block_number);
    if (b && b.hash === row.block_hash) return candidate;
    candidate = Math.max(floor, row.block_number - REORG_DEPTH);
  }
  if (candidate > floor) {
    log.error('indexer_deep_reorg', { chainId: p.o.chainId, contract: t.address, candidate });
  }
  return candidate;
}

/** Logs in [from, to], split into ranges the provider accepts, in chain order. */
async function fetchLogs(
  p: PollContext,
  address: Hex,
  from: number,
  to: number,
): Promise<RpcLog[]> {
  const out: RpcLog[] = [];
  let start = from;
  while (start <= to) {
    const end = Math.min(to, start + p.range.maxRange - 1);
    let logs: RpcLog[];
    try {
      logs = await p.o.rpc.logs(address, start, end);
    } catch (err) {
      if (end > start && isLogRangeError(err)) {
        p.range.maxRange = Math.max(1, Math.floor((end - start + 1) / 2));
        log.warn('indexer_log_range_reduced', { maxRange: p.range.maxRange });
        continue;
      }
      throw err;
    }
    for (const l of logs) if (l.address === address) out.push(l);
    start = end + 1;
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

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
  revision = revision + (CASE WHEN removed = 1 OR event <> excluded.event OR args_json <> excluded.args_json
                         THEN 1 ELSE 0 END),
  updated_at = excluded.updated_at
WHERE removed = 1 OR block_hash <> excluded.block_hash OR block_number <> excluded.block_number
   OR event <> excluded.event OR args_json <> excluded.args_json`;

const MARK_REMOVED = `UPDATE chain_events SET removed = 1, revision = revision + 1, updated_at = ?4
WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 AND removed = 0`;

const UPSERT_STATE = `INSERT INTO indexer_state (chain_id, contract, last_block_number, last_block_hash, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (chain_id, contract) DO UPDATE SET last_block_number = excluded.last_block_number,
  last_block_hash = excluded.last_block_hash, updated_at = excluded.updated_at`;

const key = (txHash: string, logIndex: number) => `${txHash}:${logIndex}`;

/**
 * Writes the scan of (from, end] for one contract: marks stored logs the scan no longer has as removed,
 * upserts the scanned ones, and moves indexer_state to `end` in the last batch. A crash part-way
 * leaves indexer_state where it was, so the next poll rescans the range and the diff converges.
 */
async function applyRange(
  p: PollContext,
  t: IndexerTarget,
  from: number,
  end: RpcBlock,
  logs: RpcLog[],
): Promise<void> {
  const { db, chainId, nowMs } = p.o;
  const stmts: D1PreparedStatement[] = [];

  const { results: live } = await db
    .prepare(
      'SELECT tx_hash, log_index FROM chain_events WHERE chain_id = ?1 AND contract = ?2 AND block_number > ?3 AND block_number <= ?4 AND removed = 0',
    )
    .bind(chainId, t.address, from, end.number)
    .all<{ tx_hash: string; log_index: number }>();
  const scanned = new Set(logs.map((l) => key(l.transactionHash, l.logIndex)));
  for (const row of live) {
    if (!scanned.has(key(row.tx_hash, row.log_index))) {
      stmts.push(db.prepare(MARK_REMOVED).bind(chainId, row.tx_hash, row.log_index, nowMs));
    }
  }

  for (const l of logs) {
    let ts = l.blockTimestamp;
    if (ts === undefined || l.blockNumber === end.number) {
      const b = await p.canonical(l.blockNumber);
      if (b.hash !== l.blockHash) throw new ReorgDuringScanError(l.blockNumber);
      ts = b.timestamp;
    }
    const { event, args } = decodeLog(t.abi, l);
    stmts.push(
      db
        .prepare(UPSERT_EVENT)
        .bind(
          chainId,
          t.address,
          l.blockNumber,
          l.blockHash,
          ts,
          l.transactionHash,
          l.logIndex,
          event,
          argsJson(args),
          nowMs,
        ),
    );
  }

  stmts.push(db.prepare(UPSERT_STATE).bind(chainId, t.address, end.number, end.hash, nowMs));
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE));
  }
}
