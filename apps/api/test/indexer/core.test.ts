// Indexer core against a scripted chain: mirroring every escrow and anchor log into chain_events,
// eth_getLogs ranges within a provider's limit, and lag. Reorgs are in reorg.test.ts.
import { env } from 'cloudflare:test';
import { flockedAnchorAbi, flockedEscrowAbi } from '@flocked/abi';
import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexOnce, readIndexState, type IndexOptions } from '../../src/indexer/core.js';
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
    expect(range.maxRange).toBeLessThanOrEqual(300);
    expect(chain.logCalls.every(([a, b]) => b - a + 1 <= 800)).toBe(true);
    const accepted = chain.logCalls.filter(([a, b]) => b - a + 1 <= 300);
    expect(accepted.length).toBeGreaterThan(0);

    const r2 = await run({ range, maxBlocksPerPoll: 800 });
    expect(r2).toMatchObject({ fromBlock: 801, toBlock: 1000, events: 1 });
    expect(await storedEvents(dep.chainId, dep.anchor)).toHaveLength(1);
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
