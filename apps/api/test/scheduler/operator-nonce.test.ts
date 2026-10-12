// W6-A: src/chain/operator.ts is the only owner of the operator key's nonce. Its callers (the
// scheduler tick, RoundDO and SettlementDO alarms) run independently, and a node's `pending` count
// can be stale, so two operator sends must never share a nonce: each new one is claimed in D1.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import { firstRoundAtOrAfter } from '@flocked/tlock';
import type { Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRound,
  propose,
  voidRound,
  type EscrowRoundConfig,
} from '../../src/chain/operator.js';
import { log } from '../../src/lib/log.js';
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
    // x's re-sign and z's first send read the pending count together, before either is stored.
    const d = { ...deps.operator, transport: stalePendingNonce(fake, 2) };
    await Promise.all([
      createRound(env, d, { roundId: x, cfg: cfg(t) }),
      createRound(env, d, { roundId: z, cfg: cfg(t) }),
    ]);
    const nonces = [await nonceOf(`createRound:${x}`), await nonceOf(`createRound:${z}`)];
    expect(new Set(nonces).size).toBe(2);
    expect([...nonces].sort((p, q) => p - q)).toEqual([1, 2]);
  });
});
