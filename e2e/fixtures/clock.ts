// The `clock` fixture (W7-D): the game clock (`POST /__test/clock`, read by the Worker and every DO)
// and anvil's chain clock. drand runs on real time and is never moved.
//
// anvil mines no empty blocks, so its head timestamp trails wall time between transactions, and
// `indexer-reorg`'s `evm_revert` sets it back to an older block's time: a step that depends on chain
// time mines first (`mineTo`, `chainTime`). Its clock only moves forward: `warpTo` can't be undone,
// which is why the specs that need it run in a warp phase (`api-warp`, `ui-warp`), after every round
// they warp exists (playwright.config.ts).
//
// After a warp the game clock never moves behind anvil (W7-Z review): `warpTo` floors its pin at wall
// time and records the warp in `.run/e2e/warped.json`, and from then on `release()` keeps the clock
// pinned at or past anvil's head instead of returning to wall time. The record goes with the stack
// (`stack:up` and `stack:down` delete `.run`), and `stack` refuses a non-warp phase on a warped stack
// (fixtures/index.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR } from '../stack/env.mjs';
import type { Stack } from './stack';
import { poll } from './stack';

/** Where `warpTo` records that this stack's anvil was warped, and by which project. */
export const WARP_RECORD = join(RUN_DIR, 'e2e', 'warped.json');

export interface WarpRecord {
  /** The Playwright project that warped first. */
  project: string;
  /** anvil's time after that warp (s). */
  at: number;
}

/** The stack's warp record, or null while anvil has never been warped. */
export function warpRecord(): WarpRecord | null {
  if (!existsSync(WARP_RECORD)) return null;
  return JSON.parse(readFileSync(WARP_RECORD, 'utf8')) as WarpRecord;
}

export class Clock {
  #pinned: number | null = null;

  constructor(
    private readonly stack: Stack,
    /** The Playwright project this worker runs, for the warp record. */
    private readonly project = 'unknown',
  ) {}

  /** The pinned game time (epoch ms), or null on wall time. */
  get pinned(): number | null {
    return this.#pinned;
  }

  /** Pins the game clock at `ms` (rounded down to a whole second) for the Worker and every DO. */
  async pin(ms: number): Promise<void> {
    const nowMs = Math.floor(ms / 1000) * 1000;
    const res = await this.stack.seam('/clock', { nowMs }, { idempotent: true });
    if (res.status !== 200) throw new Error(`pin the clock: HTTP ${res.status}`);
    this.#pinned = nowMs;
  }

  /**
   * Back to wall time, unless anvil was warped: then the game clock stays pinned at anvil's head (or
   * wall time, or the current pin, whichever is latest), so it never runs behind the chain.
   */
  async release(): Promise<void> {
    if (warpRecord() !== null) {
      const chainMs = (await this.chainTime()) * 1000;
      await this.pin(Math.max(chainMs, Date.now(), this.#pinned ?? 0));
      return;
    }
    const res = await this.stack.seam('/clock', { nowMs: null }, { idempotent: true });
    if (res.status !== 200) throw new Error(`release the clock: HTTP ${res.status}`);
    this.#pinned = null;
  }

  /** anvil's head timestamp (s), after mining one block so it isn't stale. */
  async chainTime(): Promise<number> {
    await this.stack.testClient.mine({ blocks: 1 });
    const head = await this.stack.client.getBlock({ blockTag: 'latest' });
    return Number(head.timestamp);
  }

  /** Mines until a block is stamped at or after `sec` (the chain catching up with wall time). */
  async mineTo(sec: number, timeoutMs = 60_000): Promise<void> {
    await poll(`a block at or after ${sec}`, timeoutMs, async () =>
      (await this.chainTime()) >= sec ? true : null,
    );
  }

  /** Mines `blocks` blocks, e.g. to move anvil's `safe` tag (32 behind `latest`) past a block. */
  async mine(blocks: number): Promise<void> {
    await this.stack.testClient.mine({ blocks });
  }

  /**
   * Moves anvil's clock to at least `sec` with one block stamped then, and pins the game clock to
   * the same moment, so the backend's clock and the chain's agree. A target already behind the chain
   * pins the game clock to the chain's time instead: neither clock moves back, and the pin is never
   * behind wall time. Records the warp (WARP_RECORD). Returns anvil's time (s).
   */
  async warpTo(sec: number): Promise<number> {
    const head = Number((await this.stack.client.getBlock({ blockTag: 'latest' })).timestamp);
    if (sec > head) {
      await this.stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(sec) });
    }
    await this.stack.testClient.mine({ blocks: 1 });
    const at = Number((await this.stack.client.getBlock({ blockTag: 'latest' })).timestamp);
    if (warpRecord() === null) {
      mkdirSync(join(RUN_DIR, 'e2e'), { recursive: true });
      const record: WarpRecord = { project: this.project, at };
      writeFileSync(WARP_RECORD, `${JSON.stringify(record)}\n`);
    }
    await this.pin(Math.max(at * 1000, Date.now(), this.#pinned ?? 0));
    return at;
  }
}

/**
 * Mines a block every 2 s, as Base would, while a step waits on the indexer (anvil mines no empty
 * blocks, so a proposal, a veto or a claim would otherwise sit behind a stale head). Each block is
 * stamped at wall time or one second past the head, so this never runs anvil's clock ahead. The
 * returned function stops it and waits for the last block.
 */
export function produceBlocks(stack: Stack): () => Promise<void> {
  let on = true;
  const loop = (async () => {
    while (on) {
      await stack.testClient.mine({ blocks: 1 });
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return async () => {
    on = false;
    await loop;
  };
}
