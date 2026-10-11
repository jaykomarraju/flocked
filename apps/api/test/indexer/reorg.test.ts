// PIPE-3 (unit level): reorg detection and replay against a scripted chain. On a hash mismatch the
// indexer re-indexes from 5 blocks back (further when a stored event's block changed); logs that left
// the chain become removed = 1 and returning ones come back as a new revision. The anvil version is
// e2e/tests/indexer-reorg.test.ts.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  indexOnce,
  readIndexState,
  REORG_DEPTH,
  type IndexOptions,
} from '../../src/indexer/core.js';
import { captureAlerts, FakeChain, lockedLog, storedEvents, useDeployment } from './helpers.js';

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
    // 9 (the stored last block) - REORG_DEPTH = 4, so the rescan starts at block 5.
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

  it('a log re-mined in another block keeps its revision; one that returns after removal bumps it', async () => {
    const txHash = chain.newTxHash();
    chain.mineEmpty(2);
    const log = { ...lockedLog(dep.anchor, 1), txHash };
    chain.mine([log]); // block 3
    await run();

    // Reorg: the same transaction lands one block later, same log index.
    chain.reorg(1);
    chain.mineEmpty(1);
    chain.mine([log]); // block 4
    await run();
    let [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row).toMatchObject({ block_number: 4, removed: 0, revision: 0 });
    expect(row!.block_hash).toBe(chain.blocks[4]!.hash);

    // Reorg it out entirely, then back in.
    chain.reorg(1);
    chain.mineEmpty(2);
    await run();
    [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row).toMatchObject({ removed: 1, revision: 1 });
    chain.mine([log]);
    await run();
    [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row).toMatchObject({ removed: 0, revision: 2 });
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

  it('takes timestamps from logs when the provider includes them, checking the end block', async () => {
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
});
