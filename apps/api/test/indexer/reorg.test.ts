// PIPE-3 (unit level): reorg detection and replay against a scripted chain. On a hash mismatch the
// indexer re-indexes from the newest canonical checkpoint at or below 5 blocks back (the deploy block
// when there is none); logs that left the chain become removed = 1, returning ones come back as a new
// revision, and a log whose slot changed is a removal plus a new revision. The anvil version is
// e2e/tests/indexer-reorg.test.ts.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECKPOINTS_RECENT,
  indexOnce,
  readIndexState,
  REORG_DEPTH,
  type IndexOptions,
} from '../../src/indexer/core.js';
import {
  captureAlerts,
  FakeChain,
  hash32,
  lockedLog,
  storedCheckpoints,
  storedEvents,
  storedRemovals,
  useDeployment,
} from './helpers.js';

let seed = 150;
let chain: FakeChain;
let dep: ReturnType<typeof useDeployment>;

const run = (o: Partial<IndexOptions> = {}) =>
  indexOnce({
    db: env.DB,
    rpc: chain,
    chainId: dep.chainId,
    targets: dep.targets,
    nowMs: Date.now(),
    ...o,
  });

beforeEach(() => {
  captureAlerts();
  chain = new FakeChain();
  dep = useDeployment(seed++);
});
afterEach(() => vi.restoreAllMocks());

describe('reorgs (PIPE-3)', () => {
  it('re-indexes from 5 blocks back on a hash mismatch: dropped logs are removed, new ones stored', async () => {
    chain.mineEmpty(4);
    await run(); // a checkpoint at block 4
    const kept = chain.mine([lockedLog(dep.anchor, 1)]); // block 5, survives the reorg
    chain.mineEmpty(2);
    const dropped = chain.mine([lockedLog(dep.anchor, 2)]); // block 8, reorged out
    chain.mineEmpty(1);
    await run();
    expect(await storedEvents(dep.chainId, dep.anchor)).toHaveLength(2);

    chain.reorg(3); // drops blocks 7..9
    chain.mine([lockedLog(dep.anchor, 3)]); // new block 7
    chain.mineEmpty(3); // new head 10
    chain.logCalls.length = 0;
    const r = await run();
    expect(r.reorg).toBe(true);
    // 9 (the stored last block) - REORG_DEPTH = 4, still canonical, so the rescan starts at block 5.
    expect(chain.logCalls[0]).toEqual([9 - REORG_DEPTH + 1, 10]);

    const rows = await storedEvents(dep.chainId, dep.anchor);
    const byTx = new Map(rows.map((x) => [x.tx_hash, x]));
    expect(byTx.get(kept.logs[0]!.transactionHash)).toMatchObject({ removed: 0, revision: 0 });
    expect(byTx.get(dropped.logs[0]!.transactionHash)).toMatchObject({ removed: 1, revision: 1 });
    expect(rows.filter((x) => x.removed === 0).map((x) => x.block_number)).toEqual([5, 7]);
    expect(await readIndexState(env.DB, dep.chainId, dep.anchor)).toMatchObject({
      lastBlockNumber: 10,
      lastBlockHash: chain.blocks[10]!.hash,
    });
  });

  it('a log re-mined in another block is a removal of the old block plus a new revision; one that returns after removal bumps it', async () => {
    const txHash = chain.newTxHash();
    chain.mineEmpty(2);
    const log = { ...lockedLog(dep.anchor, 1), txHash };
    const first = chain.mine([log]); // block 3
    await run();

    // Reorg: the same transaction lands one block later, same log index. Handlers saw block 3's
    // number, hash and timestamp, so the move is a removal of those (revision 1) and the log again
    // with block 4's (revision 2), not a silent update.
    chain.reorg(1);
    chain.mineEmpty(1);
    chain.mine([log], { gapSec: 7 }); // block 4
    await run();
    let [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row).toMatchObject({ block_number: 4, removed: 0, revision: 2 });
    expect(row!.block_hash).toBe(chain.blocks[4]!.hash);
    expect(await storedRemovals(dep.chainId, dep.anchor)).toEqual([
      expect.objectContaining({
        block_number: 3,
        block_hash: first.hash,
        revision: 1,
        dispatched: 0,
      }),
    ]);

    // Reorg it out entirely, then back in.
    chain.reorg(1);
    chain.mineEmpty(2);
    await run();
    [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row).toMatchObject({ removed: 1, revision: 3, dispatched_revision: 3 });
    expect((await storedRemovals(dep.chainId, dep.anchor)).map((x) => x.revision)).toEqual([1, 3]);
    chain.mine([log]);
    await run();
    [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row).toMatchObject({ removed: 0, revision: 4 });
  });

  it('a log whose slot now holds another event or other args is a removal plus a new revision', async () => {
    const txHash = chain.newTxHash();
    chain.mineEmpty(2);
    chain.mine([{ ...lockedLog(dep.anchor, 1), txHash }]); // block 3
    await run();
    chain.reorg(1);
    chain.mine([{ ...lockedLog(dep.anchor, 2), txHash }]); // block 3 again: other args, same slot
    chain.mineEmpty(1);
    await run();
    const [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row).toMatchObject({ removed: 0, revision: 2 });
    expect(JSON.parse(row!.args_json)).toMatchObject({ roundKey: hash32('round-key-2') });
    const [removal] = await storedRemovals(dep.chainId, dep.anchor);
    expect(removal).toMatchObject({ event: 'Locked', revision: 1 });
    expect(JSON.parse(removal!.args_json)).toMatchObject({ roundKey: hash32('round-key-1') });
  });

  it('repairs a reorg deeper than 5 blocks with no stored event in the fork, from a checkpoint', async () => {
    chain.mine([lockedLog(dep.anchor, 1)]); // block 1, below the fork
    chain.mineEmpty(9);
    await run(); // checkpoint 10
    chain.mineEmpty(10);
    await run(); // checkpoint 20
    chain.mineEmpty(10);
    await run(); // checkpoint 30
    chain.reorg(16); // blocks 15..30 replaced; the old ones had no logs
    chain.mineEmpty(1);
    const moved = chain.mine([lockedLog(dep.anchor, 2)]); // block 16, far below 30 - REORG_DEPTH
    chain.mineEmpty(14); // head 30
    chain.logCalls.length = 0;
    const r = await run();
    expect(r.reorg).toBe(true);
    // Checkpoint 20 is the old branch's; 10 is canonical, so both contracts rescan from 11.
    expect(chain.logCalls.slice(0, 2)).toEqual([
      [11, 30],
      [11, 30],
    ]);
    const rows = await storedEvents(dep.chainId, dep.anchor);
    expect(rows.map((x) => [x.block_number, x.removed])).toEqual([
      [1, 0],
      [16, 0],
    ]);
    expect(rows[1]!.tx_hash).toBe(moved.logs[0]!.transactionHash);
    // The old branch's checkpoints are gone; what is left is canonical.
    const cps = await storedCheckpoints(dep.chainId, dep.anchor);
    expect(cps.map((c) => c.block_number)).toEqual([30, 10]);
    expect(cps.every((c) => c.block_hash === chain.blocks[c.block_number]!.hash)).toBe(true);
  });

  it('keeps the newest checkpoints, plus the newest of each older 1,024-block bucket', async () => {
    for (let i = 0; i < 40; i++) {
      chain.mineEmpty(1);
      await run(); // a checkpoint at each of blocks 1..40
    }
    let cps = await storedCheckpoints(dep.chainId, dep.anchor);
    expect(cps).toHaveLength(CHECKPOINTS_RECENT);
    expect(cps.at(-1)!.block_number).toBe(40 - CHECKPOINTS_RECENT + 1);
    chain.mineEmpty(2_000); // head 2040: one 2,000-block chunk
    await run();
    for (let i = 0; i < 40; i++) {
      chain.mineEmpty(1);
      await run(); // 2041..2080
    }
    cps = await storedCheckpoints(dep.chainId, dep.anchor);
    // The newest 32 (2049..2080), and the newest of buckets 0 (block 40) and 1 (1024..2047: 2047).
    expect(cps.map((c) => c.block_number)).toEqual([
      ...Array.from({ length: CHECKPOINTS_RECENT }, (_, i) => 2080 - i),
      2047,
      40,
    ]);
  });

  it('rewinds further when a stored event below the 5-block window is no longer canonical', async () => {
    chain.mineEmpty(2);
    chain.mine([lockedLog(dep.anchor, 1)]); // block 3
    chain.mineEmpty(10); // head 13
    await run();
    chain.reorg(12); // fork at block 1: blocks 2..13 replaced
    chain.mineEmpty(13); // head 14, no logs
    const r = await run();
    expect(r.reorg).toBe(true);
    const [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row).toMatchObject({ block_number: 3, removed: 1 });
  });

  it('waits when the provider is behind the stored position', async () => {
    chain.mineEmpty(5);
    chain.mine([lockedLog(dep.anchor, 1)]);
    await run();
    const stored = await readIndexState(env.DB, dep.chainId, dep.anchor);
    chain.reorg(3); // the "provider" now reports a lower head
    const r = await run();
    expect(r.reorg).toBe(false);
    expect(await readIndexState(env.DB, dep.chainId, dep.anchor)).toEqual(stored);
    expect((await storedEvents(dep.chainId, dep.anchor))[0]!.removed).toBe(0);
  });

  it('takes timestamps from the blocks it checks, whether or not logs carry them', async () => {
    chain.logTimestamps = true;
    chain.mine([lockedLog(dep.anchor, 1)]);
    chain.mine([lockedLog(dep.anchor, 2)]);
    await run();
    const rows = await env.DB.prepare(
      'SELECT block_timestamp FROM chain_events WHERE contract = ?1 ORDER BY block_number',
    )
      .bind(dep.anchor)
      .all<{ block_timestamp: number }>();
    expect(rows.results.map((x) => x.block_timestamp)).toEqual([
      chain.blocks[1]!.timestamp,
      chain.blocks[2]!.timestamp,
    ]);
  });

  it('checks every log block against the chain, even when logs carry timestamps', async () => {
    chain.logTimestamps = true;
    chain.mine([lockedLog(dep.anchor, 1)]); // block 1
    chain.mine([lockedLog(dep.anchor, 2)]); // block 2
    chain.mineEmpty(1); // head 3
    // A node behind the provider's load balancer still has another block 1.
    const stale = hash32('stale block 1');
    chain.onLogs = (logs) =>
      logs.map((l) => (l.blockNumber === 1 ? { ...l, blockHash: stale } : l));
    const r = await run();
    expect(r.reorg).toBe(true);
    expect(await storedEvents(dep.chainId, dep.anchor)).toEqual([]);
    expect(await readIndexState(env.DB, dep.chainId, dep.anchor)).toBeNull();

    chain.onLogs = null;
    await run();
    const rows = await storedEvents(dep.chainId, dep.anchor);
    expect(rows.map((x) => x.block_hash)).toEqual([chain.blocks[1]!.hash, chain.blocks[2]!.hash]);
  });
});
