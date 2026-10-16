// Indexer core against a scripted chain: mirroring every escrow and anchor log into chain_events,
// eth_getLogs ranges within a provider's limit, and lag. Reorgs are in reorg.test.ts.
import { env } from 'cloudflare:test';
import { flockedAnchorAbi, flockedEscrowAbi } from '@flocked/abi';
import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  indexOnce,
  LOG_RANGE_REGROW_AFTER,
  MAX_LOG_RANGE,
  readIndexState,
  type IndexOptions,
} from '../../src/indexer/core.js';
import { isLogRangeError } from '../../src/indexer/rpc.js';
import {
  anchorEvent,
  captureAlerts,
  escrowEvent,
  FakeChain,
  hash32,
  lockedLog,
  storedEvents,
  useDeployment,
} from './helpers.js';

let seed = 100;
let chain: FakeChain;
let dep: ReturnType<typeof useDeployment>;
let quiet: ReturnType<typeof captureAlerts>;

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
  quiet = captureAlerts();
  chain = new FakeChain();
  dep = useDeployment(seed++);
});
afterEach(() => vi.restoreAllMocks());

describe('mirroring', () => {
  it('stores every escrow and anchor event from the deploy block on, decoded', async () => {
    const roundId = 7n;
    chain.mine([
      escrowEvent(dep.escrow, 'RoleGranted', {
        role: hash32('OPERATOR_ROLE'),
        account: `0x${'0a'.repeat(20)}`,
        sender: `0x${'0b'.repeat(20)}`,
      }),
      anchorEvent(dep.anchor, 'ReceiptSignerSet', {
        signer: `0x${'0c'.repeat(20)}`,
        validFrom: 1_800_000_000n,
      }),
    ]);
    chain.mine([
      escrowEvent(dep.escrow, 'RoundCreated', {
        roundId,
        cfg: {
          opensAt: 1_800_000_000n,
          closesAt: 1_800_086_400n,
          beaconRound: 12345n,
          stake: 5_000_000n,
          feeBps: 500,
          creatorBps: 100,
          capMultiple: 10,
          minEntrants: 3,
          creator: `0x${'de'.repeat(20)}`,
          questionHash: hash32('q'),
        },
      }),
      lockedLog(dep.anchor, 1),
    ]);
    chain.mine([
      escrowEvent(dep.escrow, 'Entered', {
        roundId,
        player: `0x${'11'.repeat(20)}`,
        personTag: hash32('person'),
        ticketHash: hash32('ticket'),
        ciphertext: '0xc1c2c3',
      }),
      anchorEvent(dep.anchor, 'Committed', {
        roundKey: hash32('round-key-1'),
        commitmentRoot: hash32('root'),
        entryCount: 2,
        totalStake: 300n,
      }),
    ]);
    // A log from some other contract is not ours.
    chain.mine([{ ...lockedLog(dep.anchor, 9), address: `0x${'99'.repeat(20)}` }]);

    const r = await run();
    expect(r).toMatchObject({ events: 6, reorg: false, toBlock: chain.headNumber, lagSec: 0 });

    const escrow = await storedEvents(dep.chainId, dep.escrow);
    expect(escrow.map((e) => e.event)).toEqual(['RoleGranted', 'RoundCreated', 'Entered']);
    const created = JSON.parse(escrow[1]!.args_json) as { roundId: string; cfg: { stake: string } };
    expect(created.roundId).toBe('7');
    expect(created.cfg.stake).toBe('5000000');
    const entered = JSON.parse(escrow[2]!.args_json) as Record<string, string>;
    expect(entered).toMatchObject({
      roundId: '7',
      player: `0x${'11'.repeat(20)}`,
      ciphertext: '0xc1c2c3',
    });

    const anchor = await storedEvents(dep.chainId, dep.anchor);
    expect(anchor.map((e) => e.event)).toEqual(['ReceiptSignerSet', 'Locked', 'Committed']);
    expect(anchor.every((e) => e.removed === 0 && e.revision === 0)).toBe(true);
    expect(anchor.every((e) => e.dispatched_revision === null)).toBe(true);

    for (const t of dep.targets) {
      expect(await readIndexState(env.DB, dep.chainId, t.address)).toMatchObject({
        lastBlockNumber: chain.headNumber,
        lastBlockHash: chain.blocks[chain.headNumber]!.hash,
      });
    }
  });

  it('decodes every event of both ABIs (and keeps an unknown log raw)', async () => {
    const unknown = { address: dep.anchor, topics: [hash32('NoSuchEvent()')], data: '0x01' as Hex };
    chain.mine([unknown]);
    await run();
    const [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row!.event).toBe('unknown');
    expect(JSON.parse(row!.args_json)).toEqual({ topics: unknown.topics, data: '0x01' });
    const names = (abi: readonly { type: string; name?: string }[]) =>
      abi.filter((x) => x.type === 'event').map((x) => x.name);
    expect(names(flockedEscrowAbi).length).toBeGreaterThan(10);
    expect(names(flockedAnchorAbi)).toContain('Locked');
  });

  it('starts at the deploy block, and continues from the stored block', async () => {
    chain.mine([lockedLog(dep.anchor, 1)]); // block 1
    const first = await run();
    expect(first.fromBlock).toBe(1);
    chain.mineEmpty(3);
    chain.mine([lockedLog(dep.anchor, 2)]); // block 5
    chain.logCalls.length = 0;
    const second = await run();
    expect(second).toMatchObject({ fromBlock: 2, toBlock: 5, events: 1 });
    expect(chain.logCalls).toEqual([
      [2, 5],
      [2, 5],
    ]);
    // Caught up: nothing scanned, nothing written.
    chain.logCalls.length = 0;
    expect(await run()).toMatchObject({ fromBlock: 6, toBlock: 5, events: 0 });
    expect(chain.logCalls).toEqual([]);
  });

  it('a replayed range changes nothing', async () => {
    chain.mine([lockedLog(dep.anchor, 1), lockedLog(dep.anchor, 2)]);
    await run();
    const before = await storedEvents(dep.chainId, dep.anchor);
    // Forget the position, as after a crash between the event writes and indexer_state.
    await env.DB.prepare('DELETE FROM indexer_state WHERE chain_id = ?1').bind(dep.chainId).run();
    await run();
    expect(await storedEvents(dep.chainId, dep.anchor)).toEqual(before);
  });
});

describe('RPC log-range limits', () => {
  it('splits a scan into ranges, halving when the provider rejects one, and stops per poll', async () => {
    chain.maxLogRange = 300;
    chain.mineEmpty(999);
    chain.mine([lockedLog(dep.anchor, 1)]); // block 1000
    const range = { maxRange: 2_000 };
    const r = await run({ range, maxBlocksPerPoll: 800 });
    // One poll covers 800 blocks (1..800); the rest waits for the next poll.
    expect(r.toBlock).toBe(800);
    expect(chain.logCalls.every(([a, b]) => b - a + 1 <= 800)).toBe(true);
    const accepted = chain.logCalls.filter(([a, b]) => b - a + 1 <= 300);
    expect(accepted.length).toBeGreaterThan(0);
    // Halved below the limit (800 -> 400 -> 200). The range regrows after a run of successes, so it
    // may sit one doubling above the limit until the next rejection halves it again.
    expect(chain.logCalls.slice(0, 2).map(([a, b]) => b - a + 1)).toEqual([800, 400]);
    expect(range.maxRange).toBeLessThanOrEqual(400);
    const rejected = chain.logCalls.filter(([a, b]) => b - a + 1 > 300);
    expect(rejected.length).toBeLessThanOrEqual(2 * dep.targets.length);

    const r2 = await run({ range, maxBlocksPerPoll: 800 });
    expect(r2).toMatchObject({ fromBlock: 801, toBlock: 1000, events: 1 });
    expect(await storedEvents(dep.chainId, dep.anchor)).toHaveLength(1);
  });

  it('regrows a reduced range after a run of accepted ones (a transient timeout is not forever)', async () => {
    chain.mineEmpty(4_000); // no provider limit
    const range = { maxRange: 250 }; // learned during an earlier timeout
    await run({ range });
    expect(range.maxRange).toBeGreaterThan(250);
    expect(chain.logCalls.slice(0, LOG_RANGE_REGROW_AFTER + 1).map(([a, b]) => b - a + 1)).toEqual([
      ...Array<number>(LOG_RANGE_REGROW_AFTER).fill(250),
      500,
    ]);
    chain.mineEmpty(20_000);
    for (let i = 0; i < 4; i++) await run({ range });
    expect(range.maxRange).toBe(MAX_LOG_RANGE);
  });

  it('applies each chunk as it arrives: a failure mid-poll keeps the chunks before it', async () => {
    chain.mineEmpty(49);
    chain.mine([lockedLog(dep.anchor, 1)]); // block 50
    chain.mineEmpty(99);
    chain.mine([lockedLog(dep.anchor, 2)]); // block 150
    chain.mineEmpty(99);
    chain.mine([lockedLog(dep.anchor, 3)]); // block 250
    chain.mineEmpty(50); // head 300
    chain.onLogs = (logs, from, _to, address) => {
      if (address === dep.anchor && from > 200) throw new Error('fetch failed');
      return logs;
    };
    await expect(run({ range: { maxRange: 100 } })).rejects.toThrow('fetch failed');
    expect(await readIndexState(env.DB, dep.chainId, dep.anchor)).toMatchObject({
      lastBlockNumber: 200,
      lastBlockHash: chain.blocks[200]!.hash,
    });
    expect((await storedEvents(dep.chainId, dep.anchor)).map((e) => e.block_number)).toEqual([
      50, 150,
    ]);

    chain.onLogs = null;
    chain.logCalls.length = 0;
    const r = await run({ range: { maxRange: 100 } });
    expect(chain.logCalls).toEqual([[201, 300]]); // the escrow is already at 300
    expect(r.toBlock).toBe(300);
    expect((await storedEvents(dep.chainId, dep.anchor)).map((e) => e.block_number)).toEqual([
      50, 150, 250,
    ]);
  });

  it('recognises provider range errors but not rate limits', () => {
    expect(isLogRangeError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isLogRangeError({ message: 'x', cause: { message: 'block range too large' } })).toBe(
      true,
    );
    expect(isLogRangeError({ code: -32005, message: 'limit exceeded' })).toBe(true);
    expect(isLogRangeError(new Error('Log response size exceeded.'))).toBe(true);
    expect(isLogRangeError({ code: -32005, message: 'rate limit exceeded' })).toBe(false);
    expect(isLogRangeError(new Error('429 Too Many Requests'))).toBe(false);
    expect(isLogRangeError(new Error('fetch failed'))).toBe(false);
  });

  it('a provider failure aborts the poll without moving the position', async () => {
    chain.mine([lockedLog(dep.anchor, 1)]);
    await run();
    chain.mine([lockedLog(dep.anchor, 2)]);
    chain.down = new Error('fetch failed');
    await expect(run()).rejects.toThrow('fetch failed');
    chain.down = null;
    const r = await run();
    expect(r).toMatchObject({ fromBlock: 2, toBlock: 2, events: 1 });
  });
});

describe('lag', () => {
  it('is the head timestamp minus the indexed position when a poll stops short', async () => {
    chain.mineEmpty(100); // 2 s blocks: block 100 is 200 s after block 0
    const r = await run({ maxBlocksPerPoll: 10 });
    expect(r.toBlock).toBe(10);
    expect(r.lagSec).toBe(chain.blocks[100]!.timestamp - chain.blocks[10]!.timestamp);
    expect(quiet.alerts).toEqual([]);
  });
});

describe('W7-F1 R18: the position’s block timestamp', () => {
  it('is stored with every position: a full poll, one stopped short, a quiet stretch and a reorg rewind', async () => {
    const stamp = async () => {
      const s = await readIndexState(env.DB, dep.chainId, dep.escrow);
      if (!s) throw new Error('no position');
      return [s.lastBlockNumber, s.lastBlockTimestamp];
    };
    const at = (n: number) => [n, chain.blocks[n]!.timestamp];
    // Uneven block times, so no count of blocks gives the timestamp.
    chain.mine([escrowEvent(dep.escrow, 'Paused', { account: `0x${'0a'.repeat(20)}` })], {
      gapSec: 7,
    });
    chain.mine([], { gapSec: 11 });
    await run();
    expect(await stamp()).toEqual(at(chain.headNumber));

    // A poll that stops short of the head stores the timestamp of the block it stopped at.
    for (let i = 0; i < 6; i++) chain.mine([], { gapSec: 3 + i });
    await run({ maxBlocksPerPoll: 4 });
    expect(await stamp()).toEqual(at(chain.headNumber - 2));
    // A stretch with no escrow event at all still moves it.
    for (let i = 0; i < 5; i++) chain.mine([], { gapSec: 13 });
    await run();
    expect(await stamp()).toEqual(at(chain.headNumber));

    // A reorg: the new branch's blocks have other times.
    chain.reorg(2);
    chain.mine([], { gapSec: 40 });
    chain.mine([], { gapSec: 5 });
    chain.mine([], { gapSec: 5 });
    await run();
    expect(await stamp()).toEqual(at(chain.headNumber));
    const raw = await env.DB.prepare(
      'SELECT last_block_timestamp FROM indexer_state WHERE chain_id = ?1 AND contract = ?2',
    )
      .bind(dep.chainId, dep.anchor)
      .first<{ last_block_timestamp: number }>();
    expect(raw?.last_block_timestamp).toBe(chain.blocks[chain.headNumber]!.timestamp);
  });
});
