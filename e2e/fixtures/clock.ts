// The `clock` fixture (W7-D): the game clock (`POST /__test/clock`, read by the Worker and every DO)
// and anvil's chain clock. drand runs on real time and is never moved.
//
// anvil mines no empty blocks, so its head timestamp trails wall time between transactions, and
// `indexer-reorg`'s `evm_revert` sets it back to an older block's time: a step that depends on chain
// time mines first (`mineTo`, `chainTime`). Its clock only moves forward: `warpTo` can't be undone,
// which is why the specs that need it run in the `api-warp` project, after every round they warp
// exists (playwright.config.ts).
import type { Stack } from './stack';
import { poll } from './stack';

export class Clock {
  #pinned: number | null = null;

  constructor(private readonly stack: Stack) {}

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

  /** Back to wall time. */
  async release(): Promise<void> {
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
   * pins the game clock to the chain's time instead: neither clock moves back. Returns the time (s).
   */
  async warpTo(sec: number): Promise<number> {
    const head = Number((await this.stack.client.getBlock({ blockTag: 'latest' })).timestamp);
    if (sec > head) {
      await this.stack.testClient.setNextBlockTimestamp({ timestamp: BigInt(sec) });
    }
    await this.stack.testClient.mine({ blocks: 1 });
    const at = Number((await this.stack.client.getBlock({ blockTag: 'latest' })).timestamp);
    await this.pin(Math.max(at * 1000, this.#pinned ?? 0));
    return at;
  }
}
