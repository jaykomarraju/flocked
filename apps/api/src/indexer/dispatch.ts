// The dispatcher: hands each chain_events row to its handlers once per revision, in chain order.
// chain_events is the outbox: a row is pending while dispatched_revision IS NOT revision. Each handler's
// run is recorded in chain_event_handled in the same D1 batch as the statements it returns, so a
// replayed range (or a retry after a failure) skips handlers that already ran. Dispatch stops at the
// first failing row, so handlers always see events in order; the row is retried on the next poll.
import type { Hex } from 'viem';
import type { Env } from '../env.js';
import { raiseAlert } from '../lib/alert.js';
import { log } from '../lib/log.js';
import type { HandlerRegistry } from './registry.js';
import type { ChainEvent, ContractKind, IndexerRpc, IndexerTarget } from './types.js';

/** Rows handled per call; the rest wait for the next poll. */
export const DISPATCH_LIMIT = 200;
/** A row that has failed this many times in a row raises ALERT_DO_ERROR (once). */
export const DISPATCH_ALERT_ATTEMPTS = 5;

export interface DispatchOptions {
  chainId: number;
  targets: IndexerTarget[];
  rpc: IndexerRpc;
  nowMs: number;
  limit?: number;
}

export interface DispatchFailure {
  txHash: Hex;
  logIndex: number;
  eventName: string;
  handler: string | null;
  error: string;
  attempts: number;
}

export interface DispatchResult {
  dispatched: number;
  /** True when rows may remain (the limit was reached, or a row failed). */
  more: boolean;
  failed: DispatchFailure | null;
}

interface EventRow {
  chain_id: number;
  contract: string;
  block_number: number;
  block_hash: string;
  block_timestamp: number;
  tx_hash: string;
  log_index: number;
  event: string;
  args_json: string;
  removed: number;
  revision: number;
  dispatched_revision: number | null;
  dispatch_attempts: number;
}

function toChainEvent(row: EventRow, kinds: Map<string, ContractKind>): ChainEvent {
  return {
    chainId: row.chain_id,
    contract: row.contract as Hex,
    contractKind: kinds.get(row.contract) ?? null,
    blockNumber: row.block_number,
    blockHash: row.block_hash as Hex,
    blockTimestampSec: row.block_timestamp,
    txHash: row.tx_hash as Hex,
    logIndex: row.log_index,
    event: row.event,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    removed: row.removed === 1,
    revision: row.revision,
  };
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function dispatchPending(
  env: Env,
  registry: HandlerRegistry,
  o: DispatchOptions,
): Promise<DispatchResult> {
  const db = env.DB;
  const limit = o.limit ?? DISPATCH_LIMIT;
  const kinds = new Map(o.targets.map((t) => [t.address as string, t.kind]));
  const { results } = await db
    .prepare(
      `SELECT chain_id, contract, block_number, block_hash, block_timestamp, tx_hash, log_index, event,
              args_json, removed, revision, dispatched_revision, dispatch_attempts
       FROM chain_events WHERE chain_id = ?1 AND dispatched_revision IS NOT revision
       ORDER BY block_number, log_index LIMIT ?2`,
    )
    .bind(o.chainId, limit)
    .all<EventRow>();

  let dispatched = 0;
  for (const row of results) {
    const keyBinds = [row.chain_id, row.tx_hash, row.log_index, row.revision] as const;
    const markDone = db
      .prepare(
        `UPDATE chain_events SET dispatched_revision = ?4, dispatch_attempts = 0, dispatch_error = NULL
         WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 AND revision = ?4`,
      )
      .bind(...keyBinds);

    // Removed before any handler saw it: there is nothing to undo.
    if (row.removed === 1 && row.dispatched_revision === null) {
      await markDone.run();
      dispatched++;
      continue;
    }

    const evt = toChainEvent(row, kinds);
    const { results: done } = await db
      .prepare(
        'SELECT handler FROM chain_event_handled WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 AND revision = ?4',
      )
      .bind(...keyBinds)
      .all<{ handler: string }>();
    const seen = new Set(done.map((d) => d.handler));

    let current: string | null = null;
    try {
      for (const h of registry.for(row.event)) {
        if (seen.has(h.name)) continue;
        current = h.name;
        const stmts = (await h.fn(evt, env, { rpc: o.rpc })) ?? [];
        await db.batch([
          ...stmts,
          db
            .prepare(
              `INSERT INTO chain_event_handled (chain_id, tx_hash, log_index, revision, handler, handled_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`,
            )
            .bind(...keyBinds, h.name, o.nowMs),
        ]);
      }
      current = null;
      await markDone.run();
      dispatched++;
    } catch (err) {
      const failure: DispatchFailure = {
        txHash: evt.txHash,
        logIndex: evt.logIndex,
        eventName: evt.event,
        handler: current,
        error: errorMessage(err),
        attempts: row.dispatch_attempts + 1,
      };
      await db
        .prepare(
          `UPDATE chain_events SET dispatch_attempts = dispatch_attempts + 1, dispatch_error = ?5
           WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 AND revision = ?4`,
        )
        .bind(...keyBinds, `${current ?? 'dispatch'}: ${failure.error}`.slice(0, 1000))
        .run();
      log.error('indexer_dispatch_failed', { ...failure });
      if (failure.attempts === DISPATCH_ALERT_ATTEMPTS) {
        raiseAlert(env, 'ALERT_DO_ERROR', { source: 'indexer_dispatch', ...failure });
      }
      return { dispatched, more: true, failed: failure };
    }
  }
  return { dispatched, more: results.length === limit, failed: null };
}
