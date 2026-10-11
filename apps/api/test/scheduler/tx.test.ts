// W4-F1 review fixes in src/chain/tx.ts and src/chain/operator.ts, against the fake chain:
//   T1  every (re)broadcast records its hash first (onTxSent), a lost first broadcast included;
//   T2  fees bump only from a version a node holds, never past TX_MAX_FEE_GWEI, and receipts are
//       read only once the nonce shows something mined;
//   T3  a mined transaction whose receipt lags is not mistaken for a taken nonce;
//   T4  an abandoned createRound is cancelled at its nonce (0-value self-send) and never lands.
import { env } from 'cloudflare:test';
import { LOCKED_CONFIG_DEFAULTS, newUlid } from '@flocked/shared';
import { firstRoundAtOrAfter } from '@flocked/tlock';
import { parseGwei, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelCreateRound,
  createRound,
  driveCancellations,
  type EscrowRoundConfig,
  type OperatorDeps,
} from '../../src/chain/operator.js';
import {
  DEFAULT_MAX_FEE_PER_GAS,
  maxFeePerGasOf,
  type SentTx,
  type TxSentEvent,
} from '../../src/chain/tx.js';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import { schedulerTick } from '../../src/scheduler/tick.js';
import { drand } from '../anchor-do/helpers.js';
import { HOUR, MIN, chainHarness, insertQuestion, modeRows, setClock } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

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

async function row(purpose: string) {
  const r = await env.DB.prepare(
    'SELECT status, tx_json, tx_hash FROM operator_txs WHERE purpose = ?1',
  )
    .bind(purpose)
    .first<{ status: string; tx_json: string; tx_hash: string | null }>();
  return r ? { ...r, tx: JSON.parse(r.tx_json) as SentTx } : null;
}

describe('T1: onTxSent before every broadcast', () => {
  it('a broadcast lost before it left (onTxSent threw) is rebroadcast with its hash recorded first', async () => {
    const t = Date.UTC(2027, 6, 1, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const recorded: Hex[] = [];
    let crashing = true; // the isolate dies between saving the transaction and broadcasting it
    const d: OperatorDeps = {
      ...deps.operator,
      onTxSent: (e: TxSentEvent) => {
        if (crashing) throw new Error('crash before broadcast');
        recorded.push(e.hash);
      },
    };
    const roundId = newUlid();
    expect((await createRound(env, d, { roundId, cfg: cfg(t) })).status).toBe('pending');
    expect(fake.sent).toHaveLength(0);

    // The next run finds the node doesn't know it and sends it again, recording it first.
    crashing = false;
    expect((await createRound(env, d, { roundId, cfg: cfg(t) })).status).toBe('pending');
    expect(fake.sent).toHaveLength(1);
    expect(recorded).toEqual([fake.sent[0]!.hash]);
  });
});

describe('T2: bumps only from an accepted version, under a cap', () => {
  it('a version no node accepted is rebroadcast as it is, never re-signed at compounding fees', async () => {
    const t = Date.UTC(2027, 6, 2, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    fake.failNext.set('eth_sendRawTransaction', 100); // every node refuses it for now
    const roundId = newUlid();
    const call = () => createRound(env, deps.operator, { roundId, cfg: cfg(t) });
    expect((await call()).status).toBe('pending');
    const first = (await row(`createRound:${roundId}`))!.tx;
    for (let i = 1; i <= 6; i++) {
      setClock(t + i * 13_000); // stuck by age every time
      expect((await call()).status).toBe('pending');
    }
    const after = (await row(`createRound:${roundId}`))!.tx;
    expect(after.hashes).toEqual(first.hashes);
    expect(after.maxFeePerGas).toBe(first.maxFeePerGas);

    // Once a node takes it, it is the same transaction that goes out.
    fake.failNext.delete('eth_sendRawTransaction');
    setClock(t + 90_000);
    expect((await call()).status).toBe('pending');
    expect(fake.sent.map((x) => x.hash)).toEqual(first.hashes);
  });

  it('fees never exceed TX_MAX_FEE_GWEI; a held version at the cap is left to mine', async () => {
    const t = Date.UTC(2027, 6, 3, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    Object.assign(env, { TX_MAX_FEE_GWEI: '1.5' }); // the fake's estimate is about 1.2 gwei
    try {
      const roundId = newUlid();
      const call = () => createRound(env, deps.operator, { roundId, cfg: cfg(t) });
      expect((await call()).status).toBe('pending');
      for (let i = 1; i <= 6; i++) {
        setClock(t + i * 13_000);
        await call();
      }
      const cap = parseGwei('1.5');
      for (const tx of fake.sent) expect(tx.maxFeePerGas).toBeLessThanOrEqual(cap);
      // One bump reaches the cap; a node needs 10 % more for another, which the cap forbids.
      expect(fake.sent).toHaveLength(2);
      expect(fake.sent[1]!.maxFeePerGas).toBe(cap);
      fake.mine();
      expect(await call()).toMatchObject({ status: 'mined', txHash: fake.sent[1]!.hash });
    } finally {
      delete (env as { TX_MAX_FEE_GWEI?: string }).TX_MAX_FEE_GWEI;
    }
  });

  it('TX_MAX_FEE_GWEI is decimal gwei, with a default when unset', () => {
    expect(maxFeePerGasOf({})).toBe(DEFAULT_MAX_FEE_PER_GAS);
    expect(maxFeePerGasOf({ TX_MAX_FEE_GWEI: ' ' })).toBe(DEFAULT_MAX_FEE_PER_GAS);
    expect(maxFeePerGasOf({ TX_MAX_FEE_GWEI: '0.05' })).toBe(50_000_000n);
    for (const bad of ['0', 'abc', '-1', '1e9']) {
      expect(() => maxFeePerGasOf({ TX_MAX_FEE_GWEI: bad })).toThrow(RangeError);
    }
  });

  it('receipts are read only once the account nonce shows something mined at ours', async () => {
    const t = Date.UTC(2027, 6, 4, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const roundId = newUlid();
    const call = () => createRound(env, deps.operator, { roundId, cfg: cfg(t) });
    for (let i = 0; i < 4; i++) {
      setClock(t + i * 13_000); // pending, then stuck and replaced each time
      expect((await call()).status).toBe('pending');
    }
    expect(fake.sent.length).toBeGreaterThan(1);
    expect(fake.calls.get('eth_getTransactionReceipt') ?? 0).toBe(0);
    fake.mine();
    expect((await call()).status).toBe('mined');
    expect(fake.calls.get('eth_getTransactionReceipt')).toBe(1); // the newest version is the one
  });
});

describe('T3: a taken nonce needs two sightings, a block apart', () => {
  it('a mined createRound whose receipt lags is waited for, not re-signed at a new nonce', async () => {
    const t = Date.UTC(2027, 6, 5, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const roundId = newUlid();
    const call = () => createRound(env, deps.operator, { roundId, cfg: cfg(t) });
    expect((await call()).status).toBe('pending');
    const v1 = fake.sent[0]!.hash;
    fake.hiddenReceipts.add(v1); // mined, but this provider doesn't serve the receipt yet
    fake.mine();

    expect(await call()).toMatchObject({ status: 'pending', nonceTaken: true });
    expect(await call()).toMatchObject({ status: 'pending', nonceTaken: true }); // same block
    expect(fake.sent).toHaveLength(1);

    fake.hiddenReceipts.delete(v1);
    expect(await call()).toMatchObject({ status: 'mined', txHash: v1, chainRoundId: '1' });
    expect(fake.roundCount).toBe(1n);
  });
});

describe('T4: abandoned operator transactions are cancelled', () => {
  it('a cancelled createRound is replaced at its nonce by a 0-value self-send and never lands', async () => {
    const t = Date.UTC(2027, 6, 6, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const roundId = newUlid();
    expect((await createRound(env, deps.operator, { roundId, cfg: cfg(t) })).status).toBe(
      'pending',
    );
    const v1 = fake.sent[0]!;

    expect((await cancelCreateRound(env, deps.operator, roundId))?.status).toBe('pending');
    expect(fake.sent).toHaveLength(2);
    const cancel = fake.sent[1]!;
    expect(cancel).toMatchObject({ nonce: v1.nonce, to: v1.from, data: '0x' });
    expect(cancel.maxFeePerGas).toBeGreaterThanOrEqual((v1.maxFeePerGas * 125n) / 100n);
    // The purpose is closed to the call itself now: nothing re-signs createRound.
    expect(await createRound(env, deps.operator, { roundId, cfg: cfg(t) })).toMatchObject({
      status: 'cancelled',
    });
    expect(fake.sent).toHaveLength(2);

    fake.mine();
    expect(await driveCancellations(env, deps.operator)).toEqual({
      [`createRound:${roundId}`]: 'cancelled',
    });
    expect(await row(`createRound:${roundId}`)).toMatchObject({
      status: 'cancelled',
      tx_hash: cancel.hash,
    });
    expect(fake.roundCount).toBe(0n);

    // The shared nonce moved on: the operator's next transaction takes the next one.
    expect(
      (await createRound(env, deps.operator, { roundId: newUlid(), cfg: cfg(t) })).status,
    ).toBe('pending');
    expect(fake.sent[2]!.nonce).toBe(v1.nonce + 1);
  });

  it('the tick cancels a createRound still pending at opensAt, so it cannot land late', async () => {
    const slot = dailySlot('2027-07-07');
    const id = (await insertDailyRound(env.DB, slot)) as string;
    const qId = await insertQuestion({ status: 'scheduled' });
    await env.DB.prepare('UPDATE rounds SET question_id = ?2, config_json = ?3 WHERE id = ?1')
      .bind(
        id,
        qId,
        JSON.stringify({
          beaconDelay: 120,
          free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
          stakes: {
            ...LOCKED_CONFIG_DEFAULTS.stakes,
            creator: '0x000000000000000000000000000000000000dead',
          },
        }),
      )
      .run();
    const lockAt = slot.opensAt - 6 * HOUR;
    const { fake, deps } = await chainHarness(lockAt);
    setClock(lockAt);
    fake.automine = false;
    expect((await schedulerTick(env, deps)).stakes[id]).toBe('pending');

    // The game clock passes opensAt while the chain is still behind it: createRound could land.
    setClock(slot.opensAt + MIN);
    fake.time = slot.opensAt / 1000 - 30;
    await schedulerTick(env, deps);
    expect((await modeRows(id)).find((m) => m.mode === 'stakes')?.status).toBe('voided');
    const last = fake.sent[fake.sent.length - 1]!;
    expect(last).toMatchObject({ nonce: fake.sent[0]!.nonce, to: fake.sent[0]!.from, data: '0x' });

    fake.mine();
    const report = await schedulerTick(env, deps);
    expect(report.cancellations).toEqual({ [`createRound:${id}`]: 'cancelled' });
    expect(fake.roundCount).toBe(0n);
  });
});
