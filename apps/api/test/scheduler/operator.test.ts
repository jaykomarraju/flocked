// src/chain/operator.ts: at most one createRound per round, through crashes, overlapping cron runs and
// stuck transactions, and nothing signed for a call that would revert; a voidRound whose receipt may
// lag is no definite answer; the refund calls (W6-A).
import { env } from 'cloudflare:test';
import { flockedEscrowAbi } from '@flocked/abi';
import { newUlid } from '@flocked/shared';
import { firstRoundAtOrAfter } from '@flocked/tlock';
import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  createRound,
  refundTimeout,
  refundTooFew,
  voidRound,
  type EscrowRoundConfig,
} from '../../src/chain/operator.js';
import type { TxSentEvent } from '../../src/chain/tx.js';
import { sentTxKindOf } from '../../src/lifecycle/sent.js';
import { drand } from '../anchor-do/helpers.js';
import { HOUR, chainHarness, setClock } from './helpers.js';

function cfg(t: number): EscrowRoundConfig {
  const opensAt = t / 1000 + 6 * 3600;
  const closesAt = opensAt + 24 * 3600;
  return {
    opensAt,
    closesAt,
    beaconRound: firstRoundAtOrAfter(drand, closesAt + 120),
    stake: 5_000_000n,
    feeBps: 500,
    creatorBps: 100,
    capMultiple: 10,
    minEntrants: 20,
    creator: '0x000000000000000000000000000000000000dead',
    questionHash: `0x${'42'.repeat(32)}`,
  };
}

describe('operator createRound', () => {
  it('polls a pending transaction instead of signing again, and replaces it when stuck', async () => {
    const t = Date.UTC(2027, 5, 1, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const roundId = newUlid();
    const call = () => createRound(env, deps.operator, { roundId, cfg: cfg(t) });

    expect((await call()).status).toBe('pending');
    expect((await call()).status).toBe('pending');
    expect(fake.sent).toHaveLength(1);

    setClock(t + 13_000);
    expect((await call()).status).toBe('pending');
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]!.nonce).toBe(fake.sent[0]!.nonce);
    expect(fake.sent[1]!.maxFeePerGas).toBeGreaterThan(fake.sent[0]!.maxFeePerGas);

    fake.mine();
    const done = await call();
    expect(done).toMatchObject({ status: 'mined', chainRoundId: '1', txHash: fake.sent[1]!.hash });
    expect(await call()).toMatchObject({ status: 'mined', chainRoundId: '1' });
    expect(fake.roundCount).toBe(1n);
  });

  it('two overlapping runs broadcast one transaction', async () => {
    const t = Date.UTC(2027, 5, 2, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const roundId = newUlid();
    const results = await Promise.all([
      createRound(env, deps.operator, { roundId, cfg: cfg(t) }),
      createRound(env, deps.operator, { roundId, cfg: cfg(t) }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(fake.sent).toHaveLength(1);
  });

  it('refuses a call that would revert without signing anything', async () => {
    const t = Date.UTC(2027, 5, 3, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    const roundId = newUlid();
    const past = { ...cfg(t - 24 * HOUR) }; // opensAt already passed onchain
    const r = await createRound(env, deps.operator, { roundId, cfg: past });
    expect(r.status).toBe('refused');
    expect(fake.sent).toHaveLength(0);
    expect(
      await env.DB.prepare('SELECT 1 FROM operator_txs WHERE purpose = ?1')
        .bind(`createRound:${roundId}`)
        .first(),
    ).toBeNull();
  });

  it('refuses without OPERATOR_KEY', async () => {
    const t = Date.UTC(2027, 5, 4, 12, 0, 0);
    const { deps } = await chainHarness(t);
    const saved = env.OPERATOR_KEY;
    delete (env as { OPERATOR_KEY?: string }).OPERATOR_KEY;
    try {
      const r = await createRound(env, deps.operator, { roundId: newUlid(), cfg: cfg(t) });
      expect(r).toEqual({ status: 'refused', error: 'OPERATOR_KEY is not set' });
    } finally {
      Object.assign(env, { OPERATOR_KEY: saved });
    }
  });
});

describe('operator voidRound', () => {
  it('a nonce seen taken a block apart, with the re-sign refused, is no definite answer: its receipt may lag', async () => {
    const t = Date.UTC(2027, 5, 5, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const closesAt = t / 1000 + 60;
    fake.escrowRounds.set(7n, { closesAt: BigInt(closesAt), open: true });
    const roundId = newUlid();
    const call = () => voidRound(env, deps.operator, { roundId, chainRoundId: '7' });
    expect((await call()).status).toBe('pending');
    const v = fake.sent[0]!;

    // Mined before close, though this provider doesn't serve the receipt yet; then close passes.
    fake.hiddenReceipts.add(v.hash);
    fake.mine();
    fake.time = closesAt + 1;
    expect(await call()).toMatchObject({ status: 'pending', nonceTaken: true });
    // Seen taken again a block later, and a re-sign would revert now.
    fake.mine();
    expect(await call()).toEqual({ status: 'pending', txHash: v.hash, nonceTaken: true });
    expect(fake.sent).toHaveLength(1);

    fake.hiddenReceipts.delete(v.hash);
    expect(await call()).toMatchObject({ status: 'mined', txHash: v.hash });
  });
});

describe('operator refunds', () => {
  it('refundTooFew and refundTimeout send their calls under their own purposes and labels', async () => {
    const t = Date.UTC(2027, 5, 6, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    const labels: string[] = [];
    const d = { ...deps.operator, onTxSent: (e: TxSentEvent) => void labels.push(e.label) };
    const roundId = newUlid();
    expect((await refundTooFew(env, d, { roundId, chainRoundId: '7' })).status).toBe('mined');
    expect((await refundTimeout(env, d, { roundId, chainRoundId: '8' })).status).toBe('mined');

    expect(
      fake.sent.map((x) => decodeFunctionData({ abi: flockedEscrowAbi, data: x.data })),
    ).toEqual([
      { functionName: 'refundTooFew', args: [7n] },
      { functionName: 'refundTimeout', args: [8n] },
    ]);
    expect(labels.map(sentTxKindOf)).toEqual(['refundTooFew', 'refundTimeout']);
    const { results } = await env.DB.prepare(
      'SELECT purpose, status, tx_hash FROM operator_txs WHERE purpose IN (?1, ?2) ORDER BY purpose',
    )
      .bind(`refundTooFew:${roundId}`, `refundTimeout:${roundId}`)
      .all();
    expect(results).toEqual([
      { purpose: `refundTimeout:${roundId}`, status: 'mined', tx_hash: fake.sent[1]!.hash },
      { purpose: `refundTooFew:${roundId}`, status: 'mined', tx_hash: fake.sent[0]!.hash },
    ]);
  });
});
