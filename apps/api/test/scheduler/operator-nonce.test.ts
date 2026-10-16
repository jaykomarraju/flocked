// W6-A: src/chain/operator.ts is the only owner of the operator key's nonce. Its callers (the
// scheduler tick, RoundDO and SettlementDO alarms) run independently, and a node's `pending` count
// can be stale, so two operator sends must never share a nonce: each new one is claimed in D1.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import { firstRoundAtOrAfter } from '@flocked/tlock';
import { custom, toHex, type Hex, type Transport } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRound,
  propose,
  voidRound,
  type EscrowRoundConfig,
  type OperatorDeps,
} from '../../src/chain/operator.js';
import { log } from '../../src/lib/log.js';
import type { FakeChain } from '../anchor-do/fake-chain.js';
import { drand } from '../anchor-do/helpers.js';
import { chainHarness, setClock, stalePendingNonce } from './helpers.js';

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

async function nonceOf(purpose: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT json_extract(tx_json, '$.nonce') AS nonce FROM operator_txs WHERE purpose = ?1",
  )
    .bind(purpose)
    .first<{ nonce: number }>();
  if (!r) throw new Error(`no operator_txs row ${purpose}`);
  return r.nonce;
}

const ROOT: Hex = `0x${'11'.repeat(32)}`;
const BUNDLE: Hex = `0x${'22'.repeat(32)}`;

describe('W6-A: one owner of the operator nonce', () => {
  it('four sends started together, all reading the same stale pending count, get four nonces', async () => {
    const t = Date.UTC(2027, 7, 1, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    fake.escrowRounds.set(7n, { closesAt: BigInt(t / 1000 + 3600), open: true });
    const warn = vi.spyOn(log, 'warn');
    // Every send reads the pending count before any of them stores its transaction.
    const d = { ...deps.operator, transport: stalePendingNonce(fake, 4) };
    const [a, b, c] = [newUlid(), newUlid(), newUlid()];
    const sends = () =>
      Promise.all([
        createRound(env, d, { roundId: a, cfg: cfg(t) }),
        createRound(env, d, { roundId: b, cfg: cfg(t) }),
        voidRound(env, d, { roundId: c, chainRoundId: '7' }),
        propose(env, d, {
          roundId: c,
          chainRoundId: '7',
          attempt: 1,
          n0: 1,
          n1: 2,
          nVoid: 0,
          payoutRoot: ROOT,
          bundleHash: BUNDLE,
        }),
      ]);
    expect((await sends()).map((r) => r.status)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);

    const purposes = [`createRound:${a}`, `createRound:${b}`, `voidRound:${c}`, `propose:${c}:1`];
    const stored = await Promise.all(purposes.map(nonceOf));
    expect([...stored].sort((p, q) => p - q)).toEqual([0, 1, 2, 3]);
    expect(fake.sent.map((x) => x.nonce).sort((p, q) => p - q)).toEqual([0, 1, 2, 3]);
    // The same stale count was read by all of them: the D1 claim is what kept them apart.
    expect(warn.mock.calls.map(([name]) => name)).toContain('operator_nonce_contended');

    // No gap and no collision: one block mines all four.
    fake.mine();
    expect((await sends()).map((r) => r.status)).toEqual(['mined', 'mined', 'mined', 'mined']);
    expect(fake.roundCount).toBe(2n);
  });

  it('a re-sign after its nonce was taken claims a nonce no other row holds, though the pending count is stale', async () => {
    const t = Date.UTC(2027, 7, 2, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const [x, y] = [newUlid(), newUlid()];
    expect((await createRound(env, deps.operator, { roundId: x, cfg: cfg(t) })).status).toBe(
      'pending',
    );
    expect((await createRound(env, deps.operator, { roundId: y, cfg: cfg(t) })).status).toBe(
      'pending',
    );
    expect([await nonceOf(`createRound:${x}`), await nonceOf(`createRound:${y}`)]).toEqual([0, 1]);

    // Another transaction takes x's nonce; y stays pooled at the next one, which a stale node's
    // pending count leaves out.
    fake.consumeNonce(fake.sent[0]!.from);
    const d = { ...deps.operator, transport: stalePendingNonce(fake) };
    const call = () => createRound(env, d, { roundId: x, cfg: cfg(t) });
    expect(await call()).toMatchObject({ status: 'pending', nonceTaken: true });
    // A later block, with none of ours in it: the nonce is taken (seen twice), so x is re-signed.
    fake.block += 1n;
    expect((await call()).status).toBe('pending');
    expect(await nonceOf(`createRound:${x}`)).toBe(2);
    expect(await nonceOf(`createRound:${y}`)).toBe(1);
    expect(fake.sent.map((s) => s.nonce)).toEqual([0, 1, 2]);

    fake.mine();
    expect(await call()).toMatchObject({ status: 'mined', txHash: fake.sent[2]!.hash });
    expect(await createRound(env, deps.operator, { roundId: y, cfg: cfg(t) })).toMatchObject({
      status: 'mined',
      txHash: fake.sent[1]!.hash,
    });
  });

  it('a re-sign racing a new send, both reading the same stale count, never shares its nonce', async () => {
    const t = Date.UTC(2027, 7, 3, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const [x, z] = [newUlid(), newUlid()];
    expect((await createRound(env, deps.operator, { roundId: x, cfg: cfg(t) })).status).toBe(
      'pending',
    );
    fake.consumeNonce(fake.sent[0]!.from);
    expect(await createRound(env, deps.operator, { roundId: x, cfg: cfg(t) })).toMatchObject({
      nonceTaken: true,
    });
    fake.block += 1n;
    // x's re-sign and z's first send read the pending count together, before either is stored,
    // and z stores its transaction first (x's fee lookup is slower): only x's claim can keep them
    // apart.
    const stale = stalePendingNonce(fake, 2);
    const request = stale({}).request as (a: { method: string; params?: unknown }) => unknown;
    const slowFees = custom(
      {
        request: async (a: { method: string; params?: unknown }) => {
          if (a.method === 'eth_maxPriorityFeePerGas') {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return request(a);
        },
      },
      { retryCount: 0 },
    );
    await Promise.all([
      createRound(env, { ...deps.operator, transport: slowFees }, { roundId: x, cfg: cfg(t) }),
      createRound(env, { ...deps.operator, transport: stale }, { roundId: z, cfg: cfg(t) }),
    ]);
    expect(await nonceOf(`createRound:${z}`)).toBe(1);
    expect(await nonceOf(`createRound:${x}`)).toBe(2);
  });
});

/** A reorg drops the block that mined `hash`, and no node holds the transaction any more. */
function reorgOut(fake: FakeChain, hash: Hex): void {
  const tx = fake.sent.find((s) => s.hash === hash);
  if (!tx) throw new Error(`never sent ${hash}`);
  fake.receipts.delete(tx.hash);
  fake.known.delete(tx.hash);
  const n = fake.nonces.get(tx.from) ?? 0;
  if (n > tx.nonce) fake.nonces.set(tx.from, tx.nonce);
}

describe('W6-F1 R1: a nonce a reorg freed is used again', () => {
  it('a mined send a reorg dropped frees its nonce: the next send takes it, so nothing waits behind a gap', async () => {
    const t = Date.UTC(2027, 7, 4, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    const [x, y] = [newUlid(), newUlid()];
    expect((await createRound(env, deps.operator, { roundId: x, cfg: cfg(t) })).status).toBe(
      'mined',
    );
    expect(await nonceOf(`createRound:${x}`)).toBe(0);

    reorgOut(fake, fake.sent[0]!.hash);
    // The chain's pending count is 0 again; x's row is finished at 0 and holds nothing.
    const r = await createRound(env, deps.operator, { roundId: y, cfg: cfg(t) });
    expect(await nonceOf(`createRound:${y}`)).toBe(0);
    expect(r.status).toBe('mined');
    expect(fake.sent.map((s) => s.nonce)).toEqual([0, 0]);
  });

  it('every nonce a reorg freed below a pending send is filled first, lowest first', async () => {
    const t = Date.UTC(2027, 7, 5, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    fake.automine = false;
    const [a, b, c, d, e] = [newUlid(), newUlid(), newUlid(), newUlid(), newUlid()];
    const send = (id: string) => createRound(env, deps.operator, { roundId: id, cfg: cfg(t) });
    await send(a);
    await send(b);
    fake.mine();
    expect((await send(a)).status).toBe('mined');
    expect((await send(b)).status).toBe('mined');
    expect((await send(c)).status).toBe('pending');
    expect(await Promise.all([a, b, c].map((id) => nonceOf(`createRound:${id}`)))).toEqual([
      0, 1, 2,
    ]);

    // a's and b's block leaves the chain; c stays pooled at 2, behind the gap.
    reorgOut(fake, fake.sent[1]!.hash);
    reorgOut(fake, fake.sent[0]!.hash);
    expect((await send(d)).status).toBe('pending');
    expect((await send(e)).status).toBe('pending');
    expect(await nonceOf(`createRound:${d}`)).toBe(0);
    expect(await nonceOf(`createRound:${e}`)).toBe(1);

    fake.mine();
    expect((await Promise.all([c, d, e].map(send))).map((r) => r.status)).toEqual([
      'mined',
      'mined',
      'mined',
    ]);
  });
});

/** A node behind our own mined sends: its pending count is `count` whatever has been mined since. */
function laggingPendingCount(fake: FakeChain, count: number): Transport {
  const inner = fake.transport({}).request as unknown as (a: {
    method: string;
    params: unknown[];
  }) => Promise<unknown>;
  return custom(
    {
      request: ({ method, params }: { method: string; params?: unknown }) => {
        const p = (params ?? []) as unknown[];
        if (method === 'eth_getTransactionCount' && p[1] === 'pending') {
          return Promise.resolve(toHex(count));
        }
        return inner({ method, params: p });
      },
    },
    { retryCount: 0 },
  );
}

describe('W7-F1 R14: a pending count that lags our own mined send', () => {
  it('a mined row at or past the count holds its nonce while its receipt is served: the next send takes the one after', async () => {
    const t = Date.UTC(2027, 7, 6, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    const [x, y] = [newUlid(), newUlid()];
    expect((await createRound(env, deps.operator, { roundId: x, cfg: cfg(t) })).status).toBe(
      'mined',
    );
    expect(await nonceOf(`createRound:${x}`)).toBe(0);

    // The next send reads the pending count from a node that hasn't seen x's block: 0.
    const d = { ...deps.operator, transport: laggingPendingCount(fake, 0) };
    const r = await createRound(env, d, { roundId: y, cfg: cfg(t) });
    expect(await nonceOf(`createRound:${y}`)).toBe(1);
    expect(r.status).toBe('mined');
    expect(fake.sent.map((s) => s.nonce)).toEqual([0, 1]);
  });

  it('a finished row whose receipt is gone (a reorg) still frees its nonce, though the count lags', async () => {
    const t = Date.UTC(2027, 7, 7, 12, 0, 0);
    const { fake, deps } = await chainHarness(t);
    setClock(t);
    const [x, y, z] = [newUlid(), newUlid(), newUlid()];
    const send = (id: string, d: OperatorDeps = deps.operator) =>
      createRound(env, d, { roundId: id, cfg: cfg(t) });
    expect((await send(x)).status).toBe('mined');
    expect((await send(y)).status).toBe('mined');
    expect([await nonceOf(`createRound:${x}`), await nonceOf(`createRound:${y}`)]).toEqual([0, 1]);

    // y's block leaves the chain; a node behind x's block answers 0: x holds 0, y's 1 is free.
    reorgOut(fake, fake.sent[1]!.hash);
    const r = await send(z, { ...deps.operator, transport: laggingPendingCount(fake, 0) });
    expect(await nonceOf(`createRound:${z}`)).toBe(1);
    expect(r.status).toBe('mined');
  });
});
