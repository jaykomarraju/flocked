// IndexerDO: the chain indexer singleton (spec "Architecture": Chain indexer). The every-minute cron
// calls poll() (src/indexer/cron.ts); from closesAt − 5 min until a round's Stakes proposal confirms,
// alarms also poll every FAST_POLL_MS. Each poll mirrors new FlockedEscrow and FlockedAnchor logs into
// chain_events (src/indexer/core.ts, reorgs included), then dispatches pending rows to the registered
// handlers (src/indexer/dispatch.ts). Polls never overlap: a call during a poll joins it.
//
// ALERT_INDEXER_LAG (ALERT-4) fires when the indexed position is more than 150 s behind the chain head,
// or the RPC has been failing for that long; it repeats at most every 5 minutes while the lag lasts.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { indexerConfig } from '../indexer/config.js';
import { indexOnce, MAX_LOG_RANGE, type IndexOptions, type LogRange } from '../indexer/core.js';
import { dispatchPending } from '../indexer/dispatch.js';
import { handlers, type HandlerRegistry } from '../indexer/handlers.js';
import { viemIndexerRpc } from '../indexer/rpc.js';
import { fastPollWindow, nextAlarmDelay } from '../indexer/schedule.js';
import type { IndexerRpc } from '../indexer/types.js';
import { raiseAlert } from '../lib/alert.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';
import type {
  IndexerContractStatus,
  IndexerDORpc,
  IndexerPollResult,
  IndexerStatus,
} from './types.js';

/** The singleton's name: `env.INDEXER.idFromName(INDEXER_SINGLETON)`. */
export const INDEXER_SINGLETON = 'indexer';

/** ALERT-4 threshold (spec "Non-functional requirements" › Alerts: indexer lag over 150 s). */
export const LAG_ALERT_SEC = 150;
/** While the lag lasts, ALERT_INDEXER_LAG repeats at most this often. */
export const LAG_ALERT_REPEAT_MS = 5 * 60_000;

const LAG_KEY = 'lag';

interface LagState {
  /** The last measured lag, seconds; null before anything was measured. */
  lagSec: number | null;
  /** Game-clock ms of the last successful index, and its lag (for extrapolating during failures). */
  okAt: number | null;
  okLagSec: number;
  alertedAt: number | null;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class IndexerDO extends DurableObject<Env> implements IndexerDORpc {
  /** Builds the RPC client; tests replace it (runInDurableObject) with a scripted chain. */
  rpcFactory: (env: Env) => IndexerRpc | null = viemIndexerRpc;
  /** The handler registry dispatched through; tests may swap in their own. */
  registry: HandlerRegistry = handlers;
  /** Overrides for indexOnce (tests narrow maxBlocksPerPoll). */
  indexOptions: Pick<IndexOptions, 'maxBlocksPerPoll'> = {};

  private readonly range: LogRange = { maxRange: MAX_LOG_RANGE };
  private inflight: Promise<IndexerPollResult> | null = null;
  private rpc: IndexerRpc | null | undefined;

  poll(): Promise<IndexerPollResult> {
    this.inflight ??= this.runPoll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  override async alarm(): Promise<void> {
    await this.poll();
  }

  async status(): Promise<IndexerStatus> {
    const env = this.env;
    const chainId = Number(env.CHAIN_ID);
    const { results } = await env.DB.prepare(
      'SELECT contract, last_block_number, last_block_hash, updated_at FROM indexer_state WHERE chain_id = ?1 ORDER BY contract',
    )
      .bind(chainId)
      .all<{
        contract: string;
        last_block_number: number;
        last_block_hash: string;
        updated_at: number;
      }>();
    const lag = await this.ctx.storage.get<LagState>(LAG_KEY);
    const window = await fastPollWindow(env.DB, now(env));
    return {
      chainId,
      contracts: results.map((r): IndexerContractStatus => ({
        contract: r.contract as IndexerContractStatus['contract'],
        lastBlockNumber: r.last_block_number,
        lastBlockHash: r.last_block_hash as IndexerContractStatus['lastBlockHash'],
        updatedAt: r.updated_at,
      })),
      lagSec: lag?.lagSec ?? null,
      fastPolling: window.active,
      nextAlarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  /** One poll: index, dispatch, measure lag, reschedule. Never rejects. */
  private async runPoll(): Promise<IndexerPollResult> {
    const env = this.env;
    const nowMs = now(env);
    let result: IndexerPollResult | null = null;
    const cfg = indexerConfig(env);
    const rpc = this.getRpc();
    if (!cfg.ok || rpc === null) {
      log.warn('indexer_unconfigured', { reason: cfg.ok ? 'no BASE_RPC_URL' : cfg.reason });
    } else {
      const { chainId, targets } = cfg.config;
      try {
        const r = await indexOnce({
          db: env.DB,
          rpc,
          chainId,
          targets,
          nowMs,
          range: this.range,
          ...this.indexOptions,
        });
        result = { fromBlock: r.fromBlock, toBlock: r.toBlock, events: r.events, reorg: r.reorg };
        await this.recordLag(nowMs, r.lagSec, { head: r.head.number, toBlock: r.toBlock });
      } catch (err) {
        log.error('indexer_poll_failed', { chainId, error: errorMessage(err) });
        await this.recordLag(nowMs, null, { error: errorMessage(err) });
      }
      // Rows already mirrored are dispatched even when this poll's scan failed.
      try {
        const d = await dispatchPending(env, this.registry, { chainId, targets, rpc, nowMs });
        log.info('indexer_poll', { chainId, ...result, dispatched: d.dispatched, more: d.more });
      } catch (err) {
        log.error('indexer_dispatch_error', { chainId, error: errorMessage(err) });
      }
    }
    await this.schedule(nowMs);
    return (
      result ?? (await this.idleResult(cfg.ok ? cfg.config.targets.map((t) => t.address) : []))
    );
  }

  private getRpc(): IndexerRpc | null {
    if (this.rpc === undefined) this.rpc = this.rpcFactory(this.env);
    return this.rpc;
  }

  /** What poll() reports when nothing was scanned: the stored position (the furthest-behind contract). */
  private async idleResult(contracts: string[]): Promise<IndexerPollResult> {
    try {
      const chainId = Number(this.env.CHAIN_ID);
      const rows = await this.env.DB.prepare(
        'SELECT contract, last_block_number FROM indexer_state WHERE chain_id = ?1',
      )
        .bind(chainId)
        .all<{ contract: string; last_block_number: number }>();
      const mine = rows.results.filter(
        (r) => contracts.length === 0 || contracts.includes(r.contract),
      );
      const last = mine.length ? Math.min(...mine.map((r) => r.last_block_number)) : 0;
      return { fromBlock: last + 1, toBlock: last, events: 0, reorg: false };
    } catch {
      return { fromBlock: 1, toBlock: 0, events: 0, reorg: false };
    }
  }

  /**
   * Records the lag (measured, or extrapolated from the last success while polls fail) and raises
   * ALERT_INDEXER_LAG over LAG_ALERT_SEC, at most every LAG_ALERT_REPEAT_MS.
   */
  private async recordLag(
    nowMs: number,
    measuredSec: number | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      const prev = (await this.ctx.storage.get<LagState>(LAG_KEY)) ?? {
        lagSec: null,
        okAt: null,
        okLagSec: 0,
        alertedAt: null,
      };
      const next: LagState = { ...prev };
      if (measuredSec !== null) {
        next.lagSec = measuredSec;
        next.okAt = nowMs;
        next.okLagSec = measuredSec;
      } else {
        // Failing since the first poll: count from now.
        if (next.okAt === null) next.okAt = nowMs;
        next.lagSec = next.okLagSec + Math.max(0, Math.floor((nowMs - next.okAt) / 1000));
      }
      if (next.lagSec !== null && next.lagSec > LAG_ALERT_SEC) {
        if (next.alertedAt === null || nowMs - next.alertedAt >= LAG_ALERT_REPEAT_MS) {
          raiseAlert(this.env, 'ALERT_INDEXER_LAG', {
            lagSec: next.lagSec,
            rpcFailing: measuredSec === null,
            ...detail,
          });
          next.alertedAt = nowMs;
        }
      } else {
        next.alertedAt = null;
      }
      await this.ctx.storage.put(LAG_KEY, next);
    } catch (err) {
      log.error('indexer_lag_record_failed', { error: errorMessage(err) });
    }
  }

  /** Alarm every FAST_POLL_MS inside a fast window, at a window's opening, or none (the cron polls). */
  private async schedule(nowMs: number): Promise<void> {
    try {
      const delay = nextAlarmDelay(await fastPollWindow(this.env.DB, nowMs), nowMs);
      if (delay === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Date.now() + delay);
    } catch (err) {
      log.error('indexer_schedule_failed', { error: errorMessage(err) });
    }
  }
}
