// Voids, `refundTooFew` and the timeout: the routes into Refunded that no proposal explains (spec
// "Smart contract" › Challenge window, watcher and guardian; Rules the contract enforces). The
// watcher re-derives each reason's precondition from the chain alone.
import { env } from 'cloudflare:test';
import { generatePrivateKey } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { getVerdict } from '../src/db.js';
import { tick } from '../src/run.js';
import { verifyVerdict, watcherAddress, type Verdict } from '../src/verdict.js';
import { FakeApi, FakeChain, FakePager, fakeDeps, onchainConfigOf } from './fakes.js';
import { CLOSES_AT, publishedRoundFor, stakesFixture, type StakesFixture } from './fixture.js';

const KEY = generatePrivateKey();
const SIGNER = watcherAddress(KEY);
const REFUND_TIMEOUT = 7_200;

beforeEach(async () => {
  for (const table of ['verdicts', 'proposals', 'pages', 'round_state', 'round_snapshots']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

interface RefundWorld {
  fixture: StakesFixture;
  api: FakeApi;
  chain: FakeChain;
  pager: FakePager;
  /** No bundle is published for a round that never reached a proposal. */
  objects: Map<string, Uint8Array>;
}

async function refundWorld(i: {
  reason: number;
  /** Unix seconds of the RoundRefunded block. */
  at: number;
  entryCount?: number;
  /** What `getRound` reports, when it disagrees with the log. */
  onchainReason?: number;
}): Promise<RefundWorld> {
  const fixture = await stakesFixture();
  const published = publishedRoundFor(fixture);
  const api = new FakeApi();
  api.rounds = [published];
  api.todayId = published.id;

  const cfg = onchainConfigOf(published.config.stakes);
  const chain = new FakeChain();
  chain.refundTimeoutSec = BigInt(REFUND_TIMEOUT);
  chain.created = { cfg, txHash: `0x${'22'.repeat(32)}`, blockNumber: 10n };
  chain.roundState = {
    status: 5,
    refundReason: i.onchainReason ?? i.reason,
    entryCount: i.entryCount ?? 2,
    cfg,
  };
  chain.refunds = [{ reason: i.reason, txHash: `0x${'44'.repeat(32)}`, blockNumber: 300n }];
  chain.times.set(300n, i.at);
  return { fixture, api, chain, pager: new FakePager(), objects: new Map() };
}

async function refundVerdict(w: RefundWorld, now: number) {
  await tick(
    { ...env, WATCHER_KEY: KEY, PAGER_WEBHOOK_URL: 'https://pager.invalid/hook' },
    fakeDeps({
      api: w.api,
      chain: w.chain,
      reader: w.fixture.reader,
      objects: w.objects,
      pager: w.pager,
    }),
    now,
  );
  return getVerdict(env.DB, 'stakes_refund', w.fixture.roundId);
}

describe('refundTooFew', () => {
  it('is a match when the round really had fewer entrants than minEntrants', async () => {
    const w = await refundWorld({ reason: 1, at: CLOSES_AT + 60, entryCount: 2 });
    const v = await refundVerdict(w, (CLOSES_AT + 120) * 1000);
    expect(v?.verdict).toBe('match');
    expect(v?.reasons.join('\n')).toContain('pass refund.tooFew');
    await expect(verifyVerdict(v as Verdict, SIGNER)).resolves.toBe(true);
  });

  it('is a mismatch when the round had enough entrants', async () => {
    const w = await refundWorld({ reason: 1, at: CLOSES_AT + 60, entryCount: 7 });
    const v = await refundVerdict(w, (CLOSES_AT + 120) * 1000);
    expect(v?.verdict).toBe('mismatch');
    expect(v?.reasons.join('\n')).toContain('fail refund.tooFew');
  });

  it('is a mismatch when it was called before close', async () => {
    const w = await refundWorld({ reason: 1, at: CLOSES_AT - 60, entryCount: 2 });
    const v = await refundVerdict(w, (CLOSES_AT + 120) * 1000);
    expect(v?.verdict).toBe('mismatch');
    expect(v?.reasons.join('\n')).toContain('fail refund.time');
  });
});

describe('a void before close', () => {
  it('is a match', async () => {
    const w = await refundWorld({ reason: 4, at: CLOSES_AT - 600 });
    const v = await refundVerdict(w, (CLOSES_AT - 300) * 1000);
    expect(v?.verdict).toBe('match');
  });

  it('is a mismatch when the chain shows it after close', async () => {
    const w = await refundWorld({ reason: 4, at: CLOSES_AT + 600 });
    const v = await refundVerdict(w, (CLOSES_AT + 900) * 1000);
    expect(v?.verdict).toBe('mismatch');
    expect(v?.reasons.join('\n')).toContain('fail refund.time');
  });
});

describe('the refund timeout', () => {
  it('is a match once closesAt + REFUND_TIMEOUT has passed', async () => {
    const at = CLOSES_AT + REFUND_TIMEOUT + 30;
    const w = await refundWorld({ reason: 6, at });
    const v = await refundVerdict(w, (at + 60) * 1000);
    expect(v?.verdict).toBe('match');
  });

  it('is a mismatch before it', async () => {
    const at = CLOSES_AT + REFUND_TIMEOUT - 30;
    const w = await refundWorld({ reason: 6, at });
    const v = await refundVerdict(w, (at + 60) * 1000);
    expect(v?.verdict).toBe('mismatch');
  });
});

describe('the reasons a proposal or a veto explains', () => {
  it('leave the refund subject alone (the proposal verdict covers them)', async () => {
    for (const reason of [2, 3, 5]) {
      for (const table of ['verdicts', 'round_state', 'round_snapshots']) {
        await env.DB.prepare(`DELETE FROM ${table}`).run();
      }
      const w = await refundWorld({ reason, at: CLOSES_AT + 60 });
      expect(await refundVerdict(w, (CLOSES_AT + 120) * 1000)).toBeNull();
    }
  });

  it('a RoundRefunded reason the escrow round does not agree with is a mismatch', async () => {
    const w = await refundWorld({
      reason: 4,
      at: CLOSES_AT - 600,
      onchainReason: 1,
    });
    const v = await refundVerdict(w, (CLOSES_AT - 300) * 1000);
    expect(v?.verdict).toBe('mismatch');
    expect(v?.reasons.join('\n')).toContain('fail refund.reason');
  });
});
