// The AnchorDO's and the operator's transaction layer (apps/api/src/chain/tx.ts) against the real
// contracts on the local stack's anvil (W4-A; PIPE-2). The unit tests (apps/api/test/anchor-do) run the
// AnchorDO against a fake RPC; this file checks the same transactions on a real node:
//   * a mined `lock` batch with one item the contract skips (`Skipped`, reason 4), then a mined
//     `commit` batch with one never-locked item (`Skipped`, reason 2), inside the gas budget;
//   * a stuck `lock` (automine off) replaced at the same nonce with higher fees, and only the
//     replacement mined;
//   * `createRound`'s receipt carrying the escrow round ID that becomes `chain_round_id`.
// It signs with the stack's ANCHOR_KEY and OPERATOR_KEY, which the AnchorDO also uses once the
// stack's cron driver locks a round (W4-D), and the replacement test turns anvil's automine off for
// a moment, so it runs with no other round about to lock or close (the e2e config runs files one at
// a time; the Stack job gives this file its own step).
//
//   pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/anchor-tx.test.ts
import { flockedAnchorAbi, flockedEscrowAbi } from '@flocked/abi';
import { newUlid, roundKey } from '@flocked/shared';
import { chainFromEnv, firstRoundAtOrAfter } from '@flocked/tlock';
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { TxSender, type SentTx, type TxSentEvent } from '../../apps/api/src/chain/tx.js';
import { readDevVars, readState } from '../stack/env.mjs';

interface StackState {
  ready: boolean;
  drand: { chainHash: string; publicKey: string; genesis: number; period: number };
  anvil: { rpcUrl: string; chainId: number };
  contracts: { anchor: Hex; escrow: Hex };
}

const state = readState() as StackState | null;
const vars = readDevVars() as Record<string, string> | null;
if (!state?.ready || !vars) throw new Error('the local stack is not up: run `pnpm stack:up` first');

const drand = chainFromEnv({
  DRAND_CHAIN_HASH: state.drand.chainHash,
  DRAND_PUBLIC_KEY: state.drand.publicKey,
  DRAND_GENESIS: String(state.drand.genesis),
  DRAND_PERIOD: String(state.drand.period),
});
const anvil = createPublicClient({ transport: http(state.anvil.rpcUrl), pollingInterval: 250 });
const { anchor, escrow } = state.contracts;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The sender's clock: wall time plus a skew the replacement test moves forward. */
let skewMs = 0;
const events: TxSentEvent[] = [];
const senderFor = (key: string) =>
  new TxSender(anvil, privateKeyToAccount(key as Hex), {
    chainId: state.anvil.chainId,
    now: () => Date.now() + skewMs,
    onTxSent: (e) => {
      events.push(e);
    },
  });
const anchorer = senderFor(vars.ANCHOR_KEY!);
const operator = senderFor(vars.OPERATOR_KEY!);

interface Leaf {
  key: Hex;
  closesAt: number;
  beaconRound: number;
  questionHash: Hex;
  configHash: Hex;
}

function leaf(closesAt: number, beaconDelay = 60): Leaf {
  const roundId = newUlid();
  return {
    key: roundKey(roundId, 'free'),
    closesAt,
    beaconRound: firstRoundAtOrAfter(drand, closesAt + beaconDelay),
    questionHash: keccak256(stringToHex(`question ${roundId}`)),
    configHash: keccak256(stringToHex(`config ${roundId}`)),
  };
}

const lockData = (leaves: Leaf[]) =>
  encodeFunctionData({
    abi: flockedAnchorAbi,
    functionName: 'lock',
    args: [
      leaves.map((l) => l.key),
      leaves.map((l) => BigInt(l.closesAt)),
      leaves.map((l) => BigInt(l.beaconRound)),
      leaves.map((l) => l.questionHash),
      leaves.map((l) => l.configHash),
    ],
  });

/** The AnchorDO's gas budget: 30k per transaction plus the W2-B per-item figure, +25 %. */
const gasFor = (perItem: bigint, n: number) => ((30_000n + perItem * BigInt(n)) * 125n) / 100n;

/** The next block's time: anvil mines no empty blocks, so its head can lag the wall clock. */
async function chainNow(): Promise<number> {
  const head = Number((await anvil.getBlock({ blockTag: 'latest' })).timestamp);
  return Math.max(head, Math.floor(Date.now() / 1000));
}

async function minedReceipt(sender: TxSender, tx: SentTx, label: string) {
  for (let i = 0; i < 80; i++) {
    const c = await sender.check(tx, label);
    if (c.status === 'mined') return c;
    await sleep(250);
  }
  throw new Error('transaction not mined');
}

async function send(sender: TxSender, to: Hex, data: Hex, gas: bigint, label: string) {
  const tx = await sender.sign({ to, data, gas }, { nonce: await sender.nextNonce() });
  await sender.broadcast(tx, label);
  return { tx, mined: await minedReceipt(sender, tx, label) };
}

describe.sequential('FlockedAnchor and FlockedEscrow transactions on anvil', () => {
  it('a mined lock batch and commit batch: written keys emit events, invalid ones Skipped', async () => {
    const closesAt = (await chainNow()) + 8;
    const a = leaf(closesAt);
    const b = leaf(closesAt);
    // A beacon 30 s after close is outside the contract's [60 s, 600 s] bounds: reason 4.
    const bad = { ...leaf(closesAt), beaconRound: firstRoundAtOrAfter(drand, closesAt + 30) };

    const lock = await send(
      anchorer,
      anchor,
      lockData([a, bad, b]),
      gasFor(75_000n, 3),
      'anchor.lock',
    );
    expect(lock.mined.receipt.status).toBe('success');
    expect(lock.mined.receipt.gasUsed).toBeLessThan(BigInt(lock.tx.gas));
    const lockLogs = parseEventLogs({ abi: flockedAnchorAbi, logs: lock.mined.receipt.logs });
    expect(lockLogs.map((l) => l.eventName)).toEqual(['Locked', 'Skipped', 'Locked']);
    expect(lockLogs[1]!.args).toEqual({ roundKey: bad.key, reason: 4 });
    const onchain = await anvil.readContract({
      address: anchor,
      abi: flockedAnchorAbi,
      functionName: 'getAnchor',
      args: [a.key],
    });
    expect(onchain).toMatchObject({
      closesAt: BigInt(a.closesAt),
      beaconRound: BigInt(a.beaconRound),
      configHash: a.configHash,
    });

    // commit needs closesAt ≤ block.timestamp < beaconTime.
    while ((await chainNow()) < closesAt) await sleep(500);
    const roots = [a, b, bad].map((l) => keccak256(stringToHex(`root ${l.key}`)));
    const commit = await send(
      anchorer,
      anchor,
      encodeFunctionData({
        abi: flockedAnchorAbi,
        functionName: 'commit',
        args: [[a.key, b.key, bad.key], roots, [3, 4, 5], [75n, 100n, 125n]],
      }),
      gasFor(55_000n, 3),
      'anchor.commit',
    );
    expect(commit.mined.receipt.gasUsed).toBeLessThan(BigInt(commit.tx.gas));
    const commitLogs = parseEventLogs({ abi: flockedAnchorAbi, logs: commit.mined.receipt.logs });
    expect(commitLogs.map((l) => l.eventName)).toEqual(['Committed', 'Committed', 'Skipped']);
    expect(commitLogs[2]!.args).toEqual({ roundKey: bad.key, reason: 2 });
  });

  it('a stuck transaction is replaced at the same nonce with higher fees; only the replacement is mined', async () => {
    const closesAt = (await chainNow()) + 600;
    const first = leaf(closesAt);
    const second = leaf(closesAt);
    await anvil.request({ method: 'evm_setAutomine' as never, params: [false] as never });
    try {
      skewMs = 0;
      const v1 = await anchorer.sign(
        { to: anchor, data: lockData([first]), gas: gasFor(75_000n, 1) },
        { nonce: await anchorer.nextNonce() },
      );
      await anchorer.broadcast(v1, 'anchor.lock');
      expect((await anchorer.check(v1, 'anchor.lock')).status).toBe('pending');

      skewMs = 13_000; // past the 12 s stuck threshold
      const stuck = await anchorer.check(v1, 'anchor.lock');
      expect(stuck.status).toBe('stuck');
      if (stuck.status !== 'stuck') return;
      // anvil holds v1, so the replacement bumps from v1's own fees.
      expect(stuck.bumpFrom?.maxFeePerGas).toBe(BigInt(v1.maxFeePerGas));
      // The AnchorDO rebuilds the batch when it replaces: here it gains an item.
      const v2 = await anchorer.sign(
        { to: anchor, data: lockData([first, second]), gas: gasFor(75_000n, 2) },
        { replace: v1, bumpFrom: stuck.bumpFrom },
      );
      await anchorer.broadcast(v2, 'anchor.lock');
      expect(v2.nonce).toBe(v1.nonce);
      expect(v2.hashes).toEqual([v1.hashes[0], v2.hashes[1]]);
      expect(BigInt(v2.maxFeePerGas)).toBeGreaterThan(BigInt(v1.maxFeePerGas));
      expect(BigInt(v2.maxPriorityFeePerGas)).toBeGreaterThan(BigInt(v1.maxPriorityFeePerGas));
      expect(events.slice(-2).map((e) => e.replaces)).toEqual([[], [v1.hashes[0]]]);

      await anvil.request({ method: 'evm_mine' as never, params: [] as never });
      const c = await anchorer.check(v2, 'anchor.lock');
      expect(c.status).toBe('mined');
      if (c.status !== 'mined') return;
      expect(c.hash).toBe(v2.hashes[1]);
      const locked = parseEventLogs({ abi: flockedAnchorAbi, logs: c.receipt.logs }).map((l) =>
        l.eventName === 'Locked' ? l.args.roundKey : null,
      );
      expect(locked).toEqual([first.key, second.key]);
      await expect(anvil.getTransactionReceipt({ hash: v1.hashes[0]! })).rejects.toThrow();
    } finally {
      skewMs = 0;
      await anvil.request({ method: 'evm_setAutomine' as never, params: [true] as never });
    }
  });

  it("createRound's receipt carries the escrow round ID (chain_round_id)", async () => {
    const opensAt = (await chainNow()) + 120;
    const closesAt = opensAt + 3600;
    const data = encodeFunctionData({
      abi: flockedEscrowAbi,
      functionName: 'createRound',
      args: [
        {
          opensAt: BigInt(opensAt),
          closesAt: BigInt(closesAt),
          beaconRound: BigInt(firstRoundAtOrAfter(drand, closesAt + 120)),
          stake: 5_000_000n,
          feeBps: 500,
          creatorBps: 100,
          capMultiple: 10,
          minEntrants: 20,
          creator: '0x000000000000000000000000000000000000dEaD',
          questionHash: keccak256(stringToHex('Sheep or goats?')),
        },
      ],
    });
    const gas = await anvil.estimateGas({ account: operator.address, to: escrow, data });
    const { mined } = await send(
      operator,
      escrow,
      data,
      (gas * 130n) / 100n,
      'operator.createRound',
    );
    const created = parseEventLogs({
      abi: flockedEscrowAbi,
      eventName: 'RoundCreated',
      logs: mined.receipt.logs,
    });
    expect(created).toHaveLength(1);
    const count = await anvil.readContract({
      address: escrow,
      abi: flockedEscrowAbi,
      functionName: 'roundCount',
    });
    expect(created[0]!.args.roundId).toBe(count);
  });
});
