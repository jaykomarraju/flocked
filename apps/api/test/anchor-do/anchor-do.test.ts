// AnchorDO (PIPE-2; ALERT-2 detection): batching, per-key deadlines, partial batches with `Skipped`,
// the onchain state check before every build, stuck-transaction replacement, a taken nonce and RPC
// failures mid-batch. Against the fake chain; e2e/tests/anchor-*.test.ts repeats the core on anvil.
import { env } from 'cloudflare:test';
import { flockedAnchorAbi } from '@flocked/abi';
import { decodeFunctionData, parseEventLogs, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANCHOR_GAS, commitDeadlineSec } from '../../src/do/anchor-do.js';
import { FAKE_ANCHOR } from './fake-chain.js';
import { firstRoundAtOrAfter } from '@flocked/tlock';
import {
  T0,
  alertSpy,
  anchorsRows,
  commitItem,
  drand,
  harness,
  insertRound,
  lockItem,
  lockOnchain,
} from './helpers.js';

const closeSec = T0 / 1000 + 3600;

afterEach(() => vi.restoreAllMocks());

async function lockTx(hash: Hex) {
  return (
    await env.DB.prepare(
      'SELECT lock_tx, commit_tx FROM round_modes WHERE lock_tx = ?1 OR commit_tx = ?1',
    )
      .bind(hash)
      .all<{ lock_tx: string | null; commit_tx: string | null }>()
  ).results;
}

describe('lock batches', () => {
  it('sends every queued lock leaf in one transaction and records each confirmation', async () => {
    const h = await harness();
    const items = await Promise.all(
      [0, 1, 2].map(async () => lockItem(await insertRound(closeSec), closeSec)),
    );
    const ack = await h.stub.submitLock(items);
    expect(ack).toEqual({ queued: items.map((i) => i.roundKey), alreadyAnchored: [] });

    expect(await h.run()).toBe(true); // build, sign, broadcast (the fake mines at once)
    expect(h.fake.sent).toHaveLength(1);
    const tx = h.fake.sent[0]!;
    expect(tx.from).toBe(h.anchorer);
    expect(tx.to).toBe(FAKE_ANCHOR);
    expect(tx.nonce).toBe(0);
    expect(tx.gas).toBe(((30_000n + 3n * ANCHOR_GAS.lock) * 125n) / 100n);
    const call = decodeFunctionData({ abi: flockedAnchorAbi, data: tx.data });
    expect(call.functionName).toBe('lock');
    expect((await h.stub.status(items[0]!.roundKey)).lock.state).toBe('sent');

    await h.run(); // the receipt
    for (const i of items) {
      const s = await h.stub.status(i.roundKey);
      expect(s.lock).toMatchObject({ state: 'confirmed', txHash: tx.hash });
      expect(h.fake.anchorOf(i.roundKey).configHash).toBe(i.configHash);
    }
    const rows = (await anchorsRows()).filter((r) => r.tx_hash === tx.hash);
    expect(rows).toEqual([
      {
        kind: 'lock',
        round_keys_json: JSON.stringify(items.map((i) => i.roundKey)),
        tx_hash: tx.hash,
        // Unix seconds of the mined block, never ms.
        block_timestamp: h.fake.blockTimes.get(h.fake.block)!,
      },
    ]);
    expect(rows[0]!.block_timestamp).toBeLessThan(1e11);
    expect(await lockTx(tx.hash)).toHaveLength(3);

    // Write-once: a resubmission is already anchored and sends nothing.
    expect(await h.stub.submitLock(items)).toEqual({
      queued: [],
      alreadyAnchored: items.map((i) => i.roundKey),
    });
    await h.run();
    expect(h.fake.sent).toHaveLength(1);
  });

  it('a partial batch: the contract skips one item with Skipped and the rest still apply', async () => {
    const h = await harness();
    const alerts = alertSpy();
    const good = await Promise.all(
      [0, 1].map(async () => lockItem(await insertRound(closeSec), closeSec)),
    );
    // A beacon round 30 s after close is out of the contract's bounds (reason 4).
    const bad = {
      ...lockItem(await insertRound(closeSec), closeSec),
      beaconRound: firstRoundAtOrAfter(drand, closeSec + 30),
    };
    await h.stub.submitLock([good[0]!, bad, good[1]!]);
    await h.run();
    await h.run();

    const tx = h.fake.sent[0]!;
    const logs = parseEventLogs({
      abi: flockedAnchorAbi,
      logs: (h.fake.receipts.get(tx.hash)!.logs as never[]).map((l: Record<string, unknown>) => ({
        ...l,
        blockNumber: BigInt(l.blockNumber as string),
        logIndex: Number(l.logIndex),
      })) as never,
    });
    expect(logs.map((l) => l.eventName)).toEqual(['Locked', 'Skipped', 'Locked']);
    expect(logs[1]!.args).toEqual({ roundKey: bad.roundKey, reason: 4 });

    for (const g of good) expect((await h.stub.status(g.roundKey)).lock.state).toBe('confirmed');
    expect((await h.stub.status(bad.roundKey)).lock).toMatchObject({
      state: 'skipped',
      detail: 'skipped:beacon_bounds',
    });
    expect(alerts.codes()).toEqual(['ALERT_SCHEDULE_GAP']);
    expect(await lockTx(tx.hash)).toHaveLength(2);
  });

  it('checks onchain state first: a key written with our values is confirmed with no transaction, other values are a mismatch', async () => {
    const h = await harness();
    const same = lockItem(await insertRound(closeSec), closeSec);
    const other = lockItem(await insertRound(closeSec), closeSec);
    lockOnchain(h.fake, same);
    lockOnchain(h.fake, { ...other, configHash: `0x${'11'.repeat(32)}` });
    await h.stub.submitLock([same, other]);
    await h.run();
    expect(h.fake.sent).toHaveLength(0);
    expect((await h.stub.status(same.roundKey)).lock).toMatchObject({
      state: 'confirmed',
      detail: 'already_written',
    });
    expect((await h.stub.status(other.roundKey)).lock).toMatchObject({
      state: 'skipped',
      detail: 'mismatch',
    });
  });
});

describe('commit deadlines (PIPE-2, ALERT-2)', () => {
  it('each key’s deadline is min(closesAt + 90 s, beaconTime − 30 s)', () => {
    const slow = commitItem(lockItem('01K70000000000000000000099', closeSec, 120));
    expect(commitDeadlineSec(slow)).toBe(closeSec + 90);
    const fast = commitItem(lockItem('01K70000000000000000000099', closeSec, 60));
    expect(commitDeadlineSec(fast)).toBe(fast.beaconTimeSec - 30);
    expect(commitDeadlineSec(fast)).toBeLessThan(closeSec + 90);
  });

  it('a commit handed over after its deadline fails at once and alerts ALERT_COMMIT_LATE', async () => {
    const h = await harness();
    const alerts = alertSpy();
    const l = lockItem(await insertRound(closeSec), closeSec);
    lockOnchain(h.fake, l);
    const c = commitItem(l);
    h.at((closeSec + 91) * 1000);
    expect(await h.stub.submitCommit(c)).toEqual({ queued: [], alreadyAnchored: [] });
    expect((await h.stub.status(c.roundKey)).commit).toMatchObject({
      state: 'failed',
      detail: 'deadline_passed',
      deadlineSec: closeSec + 90,
    });
    expect(alerts.codes()).toEqual(['ALERT_COMMIT_LATE']);
    await h.run();
    expect(h.fake.sent).toHaveLength(0);
  });

  it('a queued commit whose deadline passes before it is sent fails and alerts', async () => {
    const h = await harness();
    const alerts = alertSpy();
    const l = lockItem(await insertRound(closeSec), closeSec);
    lockOnchain(h.fake, l);
    h.at((closeSec + 10) * 1000);
    await h.stub.submitCommit(commitItem(l));
    h.at((closeSec + 90) * 1000);
    await h.run();
    expect(h.fake.sent).toHaveLength(0);
    expect((await h.stub.status(l.roundKey)).commit.state).toBe('failed');
    expect(alerts.codes()).toEqual(['ALERT_COMMIT_LATE']);
  });

  it('a commit sent but unconfirmed at its deadline alerts once; a later confirmation still counts', async () => {
    const h = await harness();
    const alerts = alertSpy();
    const l = lockItem(await insertRound(closeSec), closeSec);
    lockOnchain(h.fake, l);
    h.fake.automine = false;
    h.at((closeSec + 5) * 1000);
    await h.stub.submitCommit(commitItem(l));
    await h.run();
    expect((await h.stub.status(l.roundKey)).commit.state).toBe('sent');
    h.at((closeSec + 91) * 1000);
    h.fake.time = closeSec + 20; // the chain is behind: the transaction can still land in time
    await h.run();
    await h.run();
    expect(alerts.codes()).toEqual(['ALERT_COMMIT_LATE']);
    h.fake.mine();
    await h.run();
    const s = await h.stub.status(l.roundKey);
    expect(s.commit.state).toBe('confirmed');
    expect(await lockTx(s.commit.txHash!)).toEqual([{ lock_tx: null, commit_tx: s.commit.txHash }]);
  });

  it('a commit for a key that was never locked fails before any transaction (rule 7 follows)', async () => {
    const h = await harness();
    const alerts = alertSpy();
    const l = lockItem(await insertRound(closeSec), closeSec);
    h.at((closeSec + 5) * 1000);
    await h.stub.submitCommit(commitItem(l));
    await h.run();
    expect(h.fake.sent).toHaveLength(0);
    expect((await h.stub.status(l.roundKey)).commit).toMatchObject({
      state: 'failed',
      detail: 'not_locked',
    });
    expect(alerts.codes()).toEqual(['ALERT_COMMIT_LATE']);
  });

  it('the daily commit goes alone, first; room commits sharing a beaconRound share a batch', async () => {
    const h = await harness();
    const room1 = lockItem(await insertRound(closeSec), closeSec);
    const daily = lockItem(await insertRound(closeSec, 'daily'), closeSec);
    const room2 = lockItem(await insertRound(closeSec), closeSec);
    for (const l of [room1, daily, room2]) lockOnchain(h.fake, l);
    h.at((closeSec + 3) * 1000);
    for (const l of [room1, daily, room2]) await h.stub.submitCommit(commitItem(l));

    await h.run(); // daily
    await h.run(); // its receipt, then the rooms' batch
    await h.run(); // the rooms' receipt
    const calls = h.fake.sent.map((tx) =>
      decodeFunctionData({ abi: flockedAnchorAbi, data: tx.data }),
    );
    expect(calls.map((c) => c.functionName)).toEqual(['commit', 'commit']);
    expect(calls[0]!.args[0]).toEqual([daily.roundKey]);
    expect(calls[1]!.args[0]).toEqual([room1.roundKey, room2.roundKey]);
    expect(h.fake.sent.map((t) => t.nonce)).toEqual([0, 1]);
    for (const l of [room1, daily, room2]) {
      expect((await h.stub.status(l.roundKey)).commit.state).toBe('confirmed');
    }
  });
});

describe('stuck transactions, nonces and RPC failures', () => {
  it('replaces a stuck transaction at the same nonce with higher fees, folding in new items', async () => {
    const h = await harness();
    h.fake.automine = false;
    const a = lockItem(await insertRound(closeSec), closeSec);
    await h.stub.submitLock([a]);
    await h.run();
    expect(h.fake.sent).toHaveLength(1);
    await h.run(); // not stuck yet: just polls
    expect(h.fake.sent).toHaveLength(1);

    const b = lockItem(await insertRound(closeSec), closeSec);
    await h.stub.submitLock([b]);
    h.at(T0 + 13_000);
    await h.run(); // stuck: rebuilt with b and replaced
    expect(h.fake.sent).toHaveLength(2);
    const [first, second] = h.fake.sent as [(typeof h.fake.sent)[0], (typeof h.fake.sent)[0]];
    expect(second.nonce).toBe(first.nonce);
    expect(second.maxFeePerGas).toBeGreaterThanOrEqual((first.maxFeePerGas * 125n) / 100n);
    expect(second.maxPriorityFeePerGas).toBeGreaterThanOrEqual(
      (first.maxPriorityFeePerGas * 125n) / 100n,
    );
    expect(decodeFunctionData({ abi: flockedAnchorAbi, data: second.data }).args[0]).toEqual([
      a.roundKey,
      b.roundKey,
    ]);
    // Each version has its own anchors row.
    const hashes = (await anchorsRows()).map((r) => r.tx_hash);
    expect(hashes).toEqual(expect.arrayContaining([first.hash, second.hash]));

    expect(h.fake.mine()).toEqual([second.hash]);
    await h.run();
    for (const k of [a, b]) {
      expect((await h.stub.status(k.roundKey)).lock).toMatchObject({
        state: 'confirmed',
        txHash: second.hash,
      });
    }
    expect(h.fake.receipts.has(first.hash)).toBe(false);
  });

  it('a nonce taken by another transaction puts the batch back and re-sends it at the next nonce', async () => {
    const h = await harness();
    h.fake.automine = false;
    const a = lockItem(await insertRound(closeSec), closeSec);
    await h.stub.submitLock([a]);
    await h.run();
    h.fake.consumeNonce(h.anchorer);
    await h.run();
    expect(h.fake.sent.map((t) => t.nonce)).toEqual([0, 1]);
    h.fake.mine();
    await h.run();
    expect((await h.stub.status(a.roundKey)).lock).toMatchObject({
      state: 'confirmed',
      txHash: h.fake.sent[1]!.hash,
    });
  });

  it('a broadcast lost mid-batch is rebroadcast by the next alarm', async () => {
    const h = await harness();
    h.fake.failNext.set('eth_sendRawTransaction', 1);
    const a = lockItem(await insertRound(closeSec), closeSec);
    await h.stub.submitLock([a]);
    await h.run();
    expect(h.fake.sent).toHaveLength(0);
    expect((await h.stub.status(a.roundKey)).lock.state).toBe('sent');
    await h.run(); // unknown to the node: rebroadcast (mined at once)
    expect(h.fake.sent).toHaveLength(1);
    await h.run();
    expect((await h.stub.status(a.roundKey)).lock.state).toBe('confirmed');
  });

  it('an RPC failure while building alerts ALERT_DO_ERROR and the alarm retries', async () => {
    const h = await harness();
    const alerts = alertSpy();
    h.fake.failNext.set('eth_call', 1);
    const a = lockItem(await insertRound(closeSec), closeSec);
    await h.stub.submitLock([a]);
    await h.run();
    expect(alerts.codes()).toEqual(['ALERT_DO_ERROR']);
    expect((await h.stub.status(a.roundKey)).lock.state).toBe('queued');
    await h.run();
    await h.run();
    expect((await h.stub.status(a.roundKey)).lock.state).toBe('confirmed');
  });
});

describe('manifests', () => {
  it('waits for beacon time, then anchors the manifest once', async () => {
    const h = await harness();
    const l = lockItem(await insertRound(closeSec), closeSec);
    lockOnchain(h.fake, l);
    const c = commitItem(l);
    const manifest = {
      roundKey: l.roundKey,
      roundId: l.roundId,
      mode: 'free' as const,
      manifestHash: `0x${'ab'.repeat(32)}` as const,
      beaconTimeSec: c.beaconTimeSec,
    };
    h.at((c.beaconTimeSec - 10) * 1000);
    expect((await h.stub.submitManifest(manifest)).queued).toEqual([l.roundKey]);
    await h.run();
    expect(h.fake.sent).toHaveLength(0);
    h.at(c.beaconTimeSec * 1000);
    await h.run();
    await h.run();
    expect(h.fake.sent).toHaveLength(1);
    expect((await h.stub.status(l.roundKey)).manifest.state).toBe('confirmed');
    expect(h.fake.anchorOf(l.roundKey).manifestHash).toBe(manifest.manifestHash);
  });
});
