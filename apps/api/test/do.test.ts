// Every Durable Object binding resolves to its class in the Workers runtime and each pinned RPC
// method answers "not implemented" (plan P2.4: src/do/types.ts).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ANCHOR_SINGLETON, INDEXER_SINGLETON, settlementName } from '../src/do/index.js';
import type { AnchorCommitItem, StakesEntryEvent } from '../src/do/types.js';
import { isNotImplemented } from '../src/lib/errors.js';
import { FIXTURE_IDS } from './helpers/index.js';

const HASH = `0x${'12'.repeat(32)}` as const;

async function expectNotImplemented(call: Promise<unknown>, what: string): Promise<void> {
  const err = await call.then(
    () => new Error('expected a rejection'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe(`not_implemented: ${what}`);
  expect(isNotImplemented(err)).toBe(true);
}

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

  // init, enterFree and getState are implemented (W3-B): test/round-do/.
  it('pins ingestStakesEntry, onModeResult, requestVoid', async () => {
    const s = stub();
    await expectNotImplemented(s.ingestStakesEntry(stakesEvent), 'RoundDO.ingestStakesEntry');
    await expectNotImplemented(
      s.onModeResult('free', { outcome: 'refunded', reason: 1, provisional: false }),
      'RoundDO.onModeResult',
    );
    await expectNotImplemented(s.requestVoid(), 'RoundDO.requestVoid');
  });

  it('answers fetch (future WebSocket upgrades) with a 501 envelope', async () => {
    const res = await stub().fetch('https://round/ws');
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: { code: 'not_implemented' } });
  });
});

describe('RoundViewerDO (binding ROUND_VIEWER)', () => {
  it('pins subscribe and broadcast', async () => {
    const s = env.ROUND_VIEWER.get(env.ROUND_VIEWER.idFromName(`${FIXTURE_IDS.round}:0`));
    await expectNotImplemented(
      s.subscribe({ roundId: FIXTURE_IDS.round, shard: 0, shardCount: 16, membersOnly: false }),
      'RoundViewerDO.subscribe',
    );
    await expectNotImplemented(
      s.broadcast({ type: 'revealing', roundId: FIXTURE_IDS.round, mode: 'free' }),
      'RoundViewerDO.broadcast',
    );
    expect((await s.fetch('https://viewer/ws')).status).toBe(501);
  });
});

describe('AnchorDO (binding ANCHOR)', () => {
  it('pins submitLock, submitCommit, submitManifest, status', async () => {
    const s = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
    await expectNotImplemented(
      s.submitLock([
        {
          roundKey: HASH,
          roundId: FIXTURE_IDS.round,
          mode: 'free',
          closesAtSec: 1,
          beaconRound: 1,
          questionHash: HASH,
          configHash: HASH,
        },
      ]),
      'AnchorDO.submitLock',
    );
    await expectNotImplemented(s.submitCommit(commit), 'AnchorDO.submitCommit');
    await expectNotImplemented(
      s.submitManifest({
        roundKey: HASH,
        roundId: FIXTURE_IDS.round,
        mode: 'free',
        manifestHash: HASH,
        beaconTimeSec: 2,
      }),
      'AnchorDO.submitManifest',
    );
    await expectNotImplemented(s.status(HASH), 'AnchorDO.status');
  });
});

describe('SettlementDO (binding SETTLEMENT)', () => {
  it('pins start, chunkDone, status', async () => {
    const name = settlementName(FIXTURE_IDS.round, 'free');
    expect(name).toBe(`${FIXTURE_IDS.round}:free`);
    const s = env.SETTLEMENT.get(env.SETTLEMENT.idFromName(name));
    await expectNotImplemented(
      s.start({ roundId: FIXTURE_IDS.round, mode: 'free', idempotencyKey: name }),
      'SettlementDO.start',
    );
    await expectNotImplemented(
      s.chunkDone('chunks/0', {
        entries: 0,
        valid: 0,
        tally: [
          { headcount: 0, total: '0' },
          { headcount: 0, total: '0' },
        ],
        voids: {},
        resultKey: 'results/0',
      }),
      'SettlementDO.chunkDone',
    );
    await expectNotImplemented(s.status(), 'SettlementDO.status');
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

describe('IndexerDO (binding INDEXER)', () => {
  it('pins poll and status', async () => {
    const s = env.INDEXER.get(env.INDEXER.idFromName(INDEXER_SINGLETON));
    await expectNotImplemented(s.poll(), 'IndexerDO.poll');
    await expectNotImplemented(s.status(), 'IndexerDO.status');
  });
});
