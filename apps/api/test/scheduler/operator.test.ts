// src/chain/operator.ts: at most one createRound per round, through crashes, overlapping cron runs and
// stuck transactions, and nothing signed for a call that would revert.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import { firstRoundAtOrAfter } from '@flocked/tlock';
import { describe, expect, it } from 'vitest';
import { createRound, type EscrowRoundConfig } from '../../src/chain/operator.js';
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
