// The dispatcher: hands each change in chain_events to its handlers once per revision. There are two
// queues. Removals (chain_event_removals, written by migration 0007's trigger whenever a live row
// leaves the chain or its slot now holds a different log) go first, newest first: a log re-mined at a
// lower (block, logIndex) is a new row plus the old row's removal, and undoing the old one after the
// new one is applied would clear what the new one set. Additions (chain_events rows whose
// dispatched_revision IS NOT revision) follow in chain order.
//
// Each handler's run is recorded in chain_event_handled in the same D1 batch as the statements it
// returns, so a replay or a retry skips handlers that already ran. A removal goes to exactly the
// handlers that saw the revision it undoes (revision - 1); a handler that never saw the addition is
// never handed its removal. Dispatch stops at the first failing entry, so ordered handlers always see
// changes in order; the entry is retried on the next poll, and ALERT_DO_ERROR repeats while it keeps
// failing. Handlers registered as independent (ALERT-8) don't depend on order: while an entry is
// stuck, they still see the additions behind it.
import type { Hex } from 'viem';
import type { Env } from '../env.js';
import { raiseAlert } from '../lib/alert.js';
import { log } from '../lib/log.js';
import { ANY_EVENT, type HandlerRegistry, type RegisteredHandler } from './registry.js';
import type { ChainEvent, ContractKind, IndexerRpc, IndexerTarget } from './types.js';

/**
 * Entries (removals and additions) handled per call; the rest wait for the next poll. Sized for the
 * Workers subrequest budget (test/indexer/budget.test.ts measures a worst-case poll).
 */
export const DISPATCH_LIMIT = 25;
/** An entry that has failed this many times in a row raises ALERT_DO_ERROR... */
export const DISPATCH_ALERT_ATTEMPTS = 5;
/** ...and raises it again this often while it keeps failing. */
export const DISPATCH_ALERT_REPEAT_MS = 30 * 60_000;

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
  removal: boolean;
  handler: string | null;
  error: string;
  attempts: number;
}

export interface DispatchResult {
  /** Entries every due handler has now seen. */
  dispatched: number;
  /** True when entries may remain (the limit was reached, or an entry failed). */
  more: boolean;
  failed: DispatchFailure | null;
  /** Independent-handler runs on additions behind a failing entry. */
  independent: number;
}

interface EntryRow {
  chain_id: number;
  contract: string;
  block_number: number;
  block_hash: string;
  block_timestamp: number;
  tx_hash: string;
  log_index: number;
  event: string;
  args_json: string;
  revision: number;
  dispatch_attempts: number;
  dispatch_alerted_at: number | null;
  /** JSON [[revision, handler], ...] from chain_event_handled for this revision (and, for a removal, the one it undoes). */
  handled: string;
}

const COLUMNS = `chain_id, contract, block_number, block_hash, block_timestamp, tx_hash, log_index, event,
  args_json, revision, dispatch_attempts, dispatch_alerted_at`;
const HANDLED = (t: string, revisions: string) =>
  `(SELECT json_group_array(json_array(h.revision, h.handler)) FROM chain_event_handled h
    WHERE h.chain_id = ${t}.chain_id AND h.tx_hash = ${t}.tx_hash AND h.log_index = ${t}.log_index
      AND h.revision IN (${revisions})) AS handled`;

const REMOVALS = `SELECT ${COLUMNS}, ${HANDLED('r', 'r.revision - 1, r.revision')}
FROM chain_event_removals r WHERE r.chain_id = ?1 AND r.dispatched = 0
ORDER BY r.block_number DESC, r.log_index DESC, r.revision DESC LIMIT ?2`;

const ADDITIONS = `SELECT ${COLUMNS}, ${HANDLED('e', 'e.revision')}
FROM chain_events e WHERE e.chain_id = ?1 AND e.removed = 0 AND e.dispatched_revision IS NOT e.revision
ORDER BY e.block_number, e.log_index LIMIT ?2`;

/** Additions one independent handler has not seen (ANY_EVENT, or its event). */
const UNSEEN_ADDITIONS = `SELECT ${COLUMNS}, '[]' AS handled
FROM chain_events e WHERE e.chain_id = ?1 AND e.removed = 0 AND e.dispatched_revision IS NOT e.revision
  AND (?2 = '${ANY_EVENT}' OR e.event = ?2)
  AND NOT EXISTS (SELECT 1 FROM chain_event_handled h
    WHERE h.chain_id = e.chain_id AND h.tx_hash = e.tx_hash AND h.log_index = e.log_index
      AND h.revision = e.revision AND h.handler = ?3)
ORDER BY e.block_number, e.log_index LIMIT ?4`;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

class HandlerFailure extends Error {
  constructor(
    readonly handler: string | null,
    err: unknown,
  ) {
    super(errorMessage(err), { cause: err });
  }
}

export async function dispatchPending(
  env: Env,
  registry: HandlerRegistry,
  o: DispatchOptions,
): Promise<DispatchResult> {
  const d = new Dispatcher(env, registry, o);
  const limit = o.limit ?? DISPATCH_LIMIT;
  let left = limit;
  let more = false;

  const removals = await d.load(REMOVALS, left);
  let failed = await d.runOrdered(removals, true);
  left -= removals.length;
  if (failed === null && removals.length === limit) more = true;
  // Additions wait until every pending removal is through.
  if (failed === null && !more && left > 0) {
    const additions = await d.load(ADDITIONS, left);
    failed = await d.runOrdered(additions, false);
    left -= additions.length;
    if (additions.length > 0 && left <= 0) more = true;
  }
  if (failed !== null) {
    more = true;
    await d.runIndependent(Math.max(left, 1));
  }
  return { dispatched: d.dispatched, more, failed, independent: d.independent };
}

class Dispatcher {
  dispatched = 0;
  independent = 0;
  private readonly db: D1Database;
  private readonly kinds: Map<string, ContractKind>;

  constructor(
    private readonly env: Env,
    private readonly registry: HandlerRegistry,
    private readonly o: DispatchOptions,
  ) {
    this.db = env.DB;
    this.kinds = new Map(o.targets.map((t) => [t.address as string, t.kind]));
  }

  async load(sql: string, limit: number): Promise<EntryRow[]> {
    if (limit <= 0) return [];
    const { results } = await this.db.prepare(sql).bind(this.o.chainId, limit).all<EntryRow>();
    return results;
  }

  private event(row: EntryRow, removed: boolean): ChainEvent {
    return {
      chainId: row.chain_id,
      contract: row.contract as Hex,
      contractKind: this.kinds.get(row.contract) ?? null,
      blockNumber: row.block_number,
      blockHash: row.block_hash as Hex,
      blockTimestampSec: row.block_timestamp,
      txHash: row.tx_hash as Hex,
      logIndex: row.log_index,
      event: row.event,
      args: JSON.parse(row.args_json) as Record<string, unknown>,
      removed,
      revision: row.revision,
    };
  }

  private handledMark(row: EntryRow, handler: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO chain_event_handled (chain_id, tx_hash, log_index, revision, handler, handled_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`,
      )
      .bind(row.chain_id, row.tx_hash, row.log_index, row.revision, handler, this.o.nowMs);
  }

  private table(removal: boolean): string {
    return removal ? 'chain_event_removals' : 'chain_events';
  }

  private markDone(row: EntryRow, removal: boolean): D1PreparedStatement {
    const set = removal ? 'dispatched = 1' : 'dispatched_revision = ?4';
    return this.db
      .prepare(
        `UPDATE ${this.table(removal)} SET ${set}, dispatch_attempts = 0, dispatch_error = NULL,
           dispatch_alerted_at = NULL
         WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 AND revision = ?4`,
      )
      .bind(row.chain_id, row.tx_hash, row.log_index, row.revision);
  }

  /** Runs `rows` in order through every due handler; stops at the first failure and returns it. */
  async runOrdered(rows: EntryRow[], removal: boolean): Promise<DispatchFailure | null> {
    for (const row of rows) {
      const handled = JSON.parse(row.handled) as [number, string][];
      const seen = new Set(handled.filter(([r]) => r === row.revision).map(([, h]) => h));
      const sawAddition = new Set(
        handled.filter(([r]) => r === row.revision - 1).map(([, h]) => h),
      );
      const due = this.registry
        .for(row.event)
        .filter((h) => !seen.has(h.name) && (!removal || sawAddition.has(h.name)));
      try {
        await this.run(row, removal, due);
        this.dispatched++;
      } catch (err) {
        if (!(err instanceof HandlerFailure)) throw err;
        return this.recordFailure(row, removal, err);
      }
    }
    return null;
  }

  private async run(row: EntryRow, removal: boolean, due: RegisteredHandler[]): Promise<void> {
    if (due.length === 0) {
      await this.markDone(row, removal).run();
      return;
    }
    let evt: ChainEvent;
    try {
      evt = this.event(row, removal);
    } catch (err) {
      throw new HandlerFailure(null, err);
    }
    for (const [i, h] of due.entries()) {
      try {
        const stmts = (await h.fn(evt, this.env, { rpc: this.o.rpc })) ?? [];
        const last = i === due.length - 1 ? [this.markDone(row, removal)] : [];
        await this.db.batch([...stmts, this.handledMark(row, h.name), ...last]);
      } catch (err) {
        throw new HandlerFailure(h.name, err);
      }
    }
  }

  private async recordFailure(
    row: EntryRow,
    removal: boolean,
    err: HandlerFailure,
  ): Promise<DispatchFailure> {
    const failure: DispatchFailure = {
      txHash: row.tx_hash as Hex,
      logIndex: row.log_index,
      eventName: row.event,
      removal,
      handler: err.handler,
      error: err.message,
      attempts: row.dispatch_attempts + 1,
    };
    const nowMs = this.o.nowMs;
    const alert =
      failure.attempts >= DISPATCH_ALERT_ATTEMPTS &&
      (row.dispatch_alerted_at === null ||
        nowMs - row.dispatch_alerted_at >= DISPATCH_ALERT_REPEAT_MS);
    await this.db
      .prepare(
        `UPDATE ${this.table(removal)} SET dispatch_attempts = dispatch_attempts + 1, dispatch_error = ?5,
           dispatch_alerted_at = CASE WHEN ?6 = 1 THEN ?7 ELSE dispatch_alerted_at END
         WHERE chain_id = ?1 AND tx_hash = ?2 AND log_index = ?3 AND revision = ?4`,
      )
      .bind(
        row.chain_id,
        row.tx_hash,
        row.log_index,
        row.revision,
        `${err.handler ?? 'dispatch'}: ${failure.error}`.slice(0, 1000),
        alert ? 1 : 0,
        nowMs,
      )
      .run();
    log.error('indexer_dispatch_failed', { ...failure });
    if (alert) raiseAlert(this.env, 'ALERT_DO_ERROR', { source: 'indexer_dispatch', ...failure });
    return failure;
  }

  /**
   * While an entry is stuck, each independent handler sees the additions it hasn't seen yet (up to
   * `limit` runs in all). The entries stay pending for the ordered handlers; a failure here is logged
   * and retried on the next poll.
   */
  async runIndependent(limit: number): Promise<void> {
    for (const h of this.registry.list().filter((x) => x.independent)) {
      if (this.independent >= limit) return;
      const { results } = await this.db
        .prepare(UNSEEN_ADDITIONS)
        .bind(this.o.chainId, h.event, h.name, limit - this.independent)
        .all<EntryRow>();
      for (const row of results) {
        try {
          const stmts = (await h.fn(this.event(row, false), this.env, { rpc: this.o.rpc })) ?? [];
          await this.db.batch([...stmts, this.handledMark(row, h.name)]);
          this.independent++;
        } catch (err) {
          log.error('indexer_independent_failed', {
            handler: h.name,
            txHash: row.tx_hash,
            logIndex: row.log_index,
            error: errorMessage(err),
          });
          break;
        }
      }
    }
  }
}
