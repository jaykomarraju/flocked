// Every Durable Object binding resolves to its class in the Workers runtime and each pinned RPC
// method answers "not implemented" until it is built (plan P2.4: src/do/types.ts).
import { env, runInDurableObject } from 'cloudflare:test';
import { roundKey } from '@flocked/shared';
import { describe, expect, it } from 'vitest';
import {
  ANCHOR_SINGLETON,
  INDEXER_SINGLETON,
  settlementName,
  type SettlementDO,
} from '../src/do/index.js';
import type { AnchorCommitItem, StakesEntryEvent } from '../src/do/types.js';
import { FIXTURE_IDS } from './helpers/index.js';

const HASH = `0x${'12'.repeat(32)}` as const;

const stakesEvent: StakesEntryEvent = {
  roundId: FIXTURE_IDS.round,
  chainRoundId: '1',
  player: `0x${'11'.repeat(20)}`,
  personTag: HASH,
  ticketHash: HASH,
  stake: '5000000',
  commitment: HASH,
  userId: FIXTURE_IDS.user,
  txHash: HASH,
  blockNumber: 1,
  logIndex: 0,
  blockTimestampSec: 1,
};

const commit: AnchorCommitItem = {
  roundKey: HASH,
  roundId: FIXTURE_IDS.round,
  mode: 'free',
  root: HASH,
  entryCount: 0,
  totalStake: '0',
  closesAtSec: 1,
  beaconRound: 1,
  beaconTimeSec: 2,
};

describe('RoundDO (binding ROUND)', () => {
  const stub = () => env.ROUND.get(env.ROUND.idFromName(FIXTURE_IDS.round));

  // init, enterFree and getState are implemented (W3-B): test/round-do/. ingestStakesEntry,
  // onModeResult and requestVoid are implemented (W4-D): test/lifecycle/ and test/round-do/.
  it('answers ingestStakesEntry, onModeResult and requestVoid with not_found before init', async () => {
    const s = stub();
    const notFound = async (call: Promise<unknown>) => {
      const err = await call.then(
        () => new Error('expected a rejection'),
        (e: unknown) => e,
      );
      expect((err as Error).message).toBe('not_found: the round is not initialized');
    };
    await notFound(s.ingestStakesEntry(stakesEvent));
    await notFound(s.onModeResult('free', { outcome: 'refunded', reason: 1, provisional: false }));
    await notFound(s.requestVoid());
  });

  it('answers fetch (future WebSocket upgrades) with a 501 envelope', async () => {
    const res = await stub().fetch('https://round/ws');
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: { code: 'not_implemented' } });
  });
});

describe('RoundViewerDO (binding ROUND_VIEWER)', () => {
  // Implemented in W7-A; its behaviour is in test/ws. Here: the pinned RPC shapes.
  it('pins subscribe and broadcast', async () => {
    const s = env.ROUND_VIEWER.get(env.ROUND_VIEWER.idFromName(`${FIXTURE_IDS.round}/0`));
    const err = await s
      .subscribe({ roundId: FIXTURE_IDS.round, shard: 0, shardCount: 16, membersOnly: false })
      .then(
        () => new Error('expected a rejection'),
        (e: unknown) => e,
      );
    expect((err as Error).message).toMatch(/^not_found/);
    expect(
      await s.broadcast({ type: 'revealing', roundId: FIXTURE_IDS.round, mode: 'free' }),
    ).toEqual({ delivered: 0 });
    expect((await s.fetch('https://viewer/ws')).status).toBe(400);
  });
});

describe('AnchorDO (binding ANCHOR)', () => {
  // Implemented in W4-A; its behaviour is in test/anchor-do. Here: the pinned RPC shapes.
  it('pins submitLock, submitCommit, submitManifest, status', async () => {
    const s = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
    const key = roundKey(FIXTURE_IDS.round, 'free');
    expect(
      await s.submitLock([
        {
          roundKey: key,
          roundId: FIXTURE_IDS.round,
          mode: 'free',
          closesAtSec: 4_000_000_000,
          beaconRound: 1,
          questionHash: HASH,
          configHash: HASH,
        },
      ]),
    ).toEqual({ queued: [key], alreadyAnchored: [] });
    // Past its deadline (closesAt 1): refused at once, so neither queued nor anchored.
    expect(await s.submitCommit({ ...commit, roundKey: key })).toEqual({
      queued: [],
      alreadyAnchored: [],
    });
    // A round key that isn't keccak256(abi.encode(roundId, mode)) is ignored.
    expect(
      await s.submitManifest({
        roundKey: HASH,
        roundId: FIXTURE_IDS.round,
        mode: 'free',
        manifestHash: HASH,
        beaconTimeSec: 2,
      }),
    ).toEqual({ queued: [], alreadyAnchored: [] });
    expect(await s.status(key)).toEqual({
      roundKey: key,
      lock: { state: 'queued' },
      commit: { state: 'failed', deadlineSec: -28, detail: 'deadline_passed' },
      manifest: { state: 'none' },
    });
  });
});

// SettlementDO is implemented (W5-A); test/settlement/*.test.ts cover its behaviour. Here: the
// binding reaches the class and the pinned methods answer.
describe('SettlementDO (binding SETTLEMENT)', () => {
  it('pins start, chunkDone, status', async () => {
    const name = settlementName(FIXTURE_IDS.round, 'free');
    expect(name).toBe(`${FIXTURE_IDS.round}:free`);
    const s = env.SETTLEMENT.get(env.SETTLEMENT.idFromName(name));
    await runInDurableObject(s, (o: SettlementDO) => {
      o.manualAlarms = true;
    });
    expect((await s.status()).phase).toBe('idle');
    const done = await s.chunkDone('chunks/0', {
      entries: 0,
      valid: 0,
      tally: [
        { headcount: 0, total: '0' },
        { headcount: 0, total: '0' },
      ],
      voids: {},
      resultKey: 'results/0',
    });
    expect(done.phase).toBe('idle');
    const key = { roundId: FIXTURE_IDS.round, mode: 'free' as const, idempotencyKey: name };
    const first = await s.start(key);
    expect(first.started).toBe(true);
    expect(first.status).toMatchObject({ roundId: FIXTURE_IDS.round, phase: 'preparing' });
    expect((await s.start(key)).started).toBe(false);
  });
});

// AuthDO and RateLimitDO are implemented (W3-A); test/auth/auth-do.test.ts and
// test/auth/rate-limit.test.ts cover their behaviour. Here: the bindings reach the classes.
describe('AuthDO (binding AUTH)', () => {
  it('answers consumeNonce for an unknown nonce', async () => {
    const s = env.AUTH.get(env.AUTH.idFromName('nonce:unknown'));
    expect(await s.consumeNonce('unknown')).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('RateLimitDO (binding RATE_LIMIT)', () => {
  it('answers take', async () => {
    const bucket = { key: `user:${FIXTURE_IDS.user}:entries`, capacity: 10, periodMs: 60_000 };
    const s = env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(bucket.key));
    expect(await s.take(bucket, 1)).toEqual({ allowed: true, remaining: 9, retryAfterMs: 0 });
  });
});

// IndexerDO is implemented (W4-B); test/indexer/indexer-do.test.ts covers its behaviour. Here: the
// binding reaches the class (with no RPC URL in tests, a poll indexes nothing).
describe('IndexerDO (binding INDEXER)', () => {
  it('answers poll and status', async () => {
    const s = env.INDEXER.get(env.INDEXER.idFromName(INDEXER_SINGLETON));
    expect(await s.poll()).toEqual({ fromBlock: 1, toBlock: 0, events: 0, reorg: false });
    expect(await s.status()).toMatchObject({ chainId: 31337, contracts: [], lagSec: null });
  });
});
