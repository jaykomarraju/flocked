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

  it('a commit mined before close on the chain’s clock (Skipped 3) is retried, not dropped', async () => {
    const h = await harness();
    const l = lockItem(await insertRound(closeSec), closeSec);
    lockOnchain(h.fake, l);
    h.at((closeSec + 1) * 1000);
    h.fake.time = closeSec - 2; // the chain is behind the game clock
    await h.stub.submitCommit(commitItem(l));
    await h.run(); // sent and mined at closeSec − 2: skipped as outside its window
    await h.run(); // early, so back in the queue and sent again (now at closeSec)
    await h.run();
    expect(h.fake.sent).toHaveLength(2);
    expect((await h.stub.status(l.roundKey)).commit).toMatchObject({
      state: 'confirmed',
      txHash: h.fake.sent[1]!.hash,
    });
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
    // Seen once: it could be our own version with its receipt not served yet (T3), so it waits.
    await h.run();
    expect(h.fake.sent.map((t) => t.nonce)).toEqual([0]);
    h.fake.mine(); // a later block: seen again there, the nonce is taken
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

describe('W4-F1 review fixes', () => {
  it('N1: a reverted earlier version fails only its own keys; the replacement’s other keys are resent', async () => {
    const h = await harness();
    h.fake.automine = false;
    const a = lockItem(await insertRound(closeSec), closeSec);
    await h.stub.submitLock([a]);
    await h.run(); // v1: lock [a]
    const b = lockItem(await insertRound(closeSec), closeSec);
    await h.stub.submitLock([b]);
    h.at(T0 + 13_000);
    await h.run(); // stuck: v2 = lock [a, b] at the same nonce
    const [v1, v2] = h.fake.sent as [(typeof h.fake.sent)[0], (typeof h.fake.sent)[0]];
    expect(v2.nonce).toBe(v1.nonce);

    // The earlier version wins the race, and reverts.
    h.fake.revertHashes.add(v1.hash);
    h.fake.mineVersion(v1.hash);
    await h.run();
    expect((await h.stub.status(a.roundKey)).lock).toMatchObject({
      state: 'failed',
      detail: 'reverted',
    });
    // b was only ever in v2, which can't be mined now: it goes out again at the next nonce.
    expect((await h.stub.status(b.roundKey)).lock.state).toBe('sent');
    const v3 = h.fake.sent[2]!;
    expect(v3.nonce).toBe(v1.nonce + 1);
    expect(decodeFunctionData({ abi: flockedAnchorAbi, data: v3.data }).args[0]).toEqual([
      b.roundKey,
    ]);
    h.fake.mine();
    await h.run();
    expect((await h.stub.status(b.roundKey)).lock.state).toBe('confirmed');
  });

  it('N1: an earlier version of another kind that lands is applied as what it is', async () => {
    const h = await harness();
    h.fake.automine = false;
    const soon = T0 / 1000 + 60;
    const a = lockItem(await insertRound(soon), soon);
    await h.stub.submitLock([a]);
    await h.run(); // v1: lock [a]

    // A room round that closed already has its commit due.
    const closed = T0 / 1000 - 10;
    const l2 = lockItem(await insertRound(closed), closed);
    lockOnchain(h.fake, l2);
    // Our clock passes a's closesAt (its window is gone for us), the chain's is still before it.
    h.at(T0 + 61_000);
    h.fake.time = T0 / 1000 + 50;
    await h.stub.submitCommit(commitItem(l2));
    await h.run(); // stuck: a can't be sent again, so v2 = commit [l2] at the same nonce
    const [v1, v2] = h.fake.sent as [(typeof h.fake.sent)[0], (typeof h.fake.sent)[0]];
    expect(decodeFunctionData({ abi: flockedAnchorAbi, data: v2.data }).functionName).toBe(
      'commit',
    );
    expect((await h.stub.status(a.roundKey)).lock.state).toBe('failed');

    // v1 lands before closesAt on the chain's clock: a is locked after all.
    h.fake.mineVersion(v1.hash);
    await h.run();
    expect((await h.stub.status(a.roundKey)).lock).toMatchObject({
      state: 'confirmed',
      txHash: v1.hash,
    });
    expect(await lockTx(v1.hash)).toEqual([{ lock_tx: v1.hash, commit_tx: null }]);
    // l2's commit was only in v2: it is sent again at the next nonce.
    expect((await h.stub.status(l2.roundKey)).commit.state).toBe('sent');
    expect(h.fake.sent[2]!.nonce).toBe(v1.nonce + 1);
  });

  it('N1: a manifest that reverts in a block stamped before beacon time is retried, not failed', async () => {
    const h = await harness();
    const l = lockItem(await insertRound(closeSec), closeSec);
    lockOnchain(h.fake, l);
    const beacon = commitItem(l).beaconTimeSec;
    h.at(beacon * 1000);
    h.fake.time = beacon - 5; // the chain is behind our clock
    await h.stub.submitManifest({
      roundKey: l.roundKey,
      roundId: l.roundId,
      mode: 'free',
      manifestHash: `0x${'cd'.repeat(32)}`,
      beaconTimeSec: beacon,
    });
    await h.run(); // sent and mined at beacon − 5: BeaconNotReached
    await h.run(); // the revert is early: back in the queue a little later
    expect((await h.stub.status(l.roundKey)).manifest.state).toBe('queued');
    h.at((beacon + 6) * 1000);
    await h.run();
    await h.run();
    expect(h.fake.sent).toHaveLength(2);
    expect((await h.stub.status(l.roundKey)).manifest).toMatchObject({
      state: 'confirmed',
      txHash: h.fake.sent[1]!.hash,
    });
  });

  it('N2: a confirmed key resubmitted after a reorg removed its write is checked again and resent', async () => {
    const h = await harness();
    const a = lockItem(await insertRound(closeSec), closeSec);
    await h.stub.submitLock([a]);
    await h.run();
    await h.run();
    expect((await h.stub.status(a.roundKey)).lock.state).toBe('confirmed');

    h.fake.anchors.delete(a.roundKey); // a reorg dropped the write
    expect(await h.stub.submitLock([a])).toEqual({ queued: [a.roundKey], alreadyAnchored: [] });
    await h.run();
    await h.run();
    expect(h.fake.sent).toHaveLength(2);
    expect((await h.stub.status(a.roundKey)).lock).toMatchObject({
      state: 'confirmed',
      txHash: h.fake.sent[1]!.hash,
    });
    // Still written: a resubmission stays confirmed and sends nothing.
    expect(await h.stub.submitLock([a])).toEqual({ queued: [], alreadyAnchored: [a.roundKey] });
    await h.run();
    expect(h.fake.sent).toHaveLength(2);
  });

  it('N3: a key found written onchain records the transaction that wrote it and its round_modes value', async () => {
    const h = await harness();
    const l = lockItem(await insertRound(closeSec), closeSec);
    lockOnchain(h.fake, l);
    // The indexer mirrored the Locked event of the transaction that wrote it.
    const txHash: Hex = `0x${'7e'.repeat(32)}`;
    await env.DB.prepare(
      `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash,
         log_index, event, args_json, created_at, updated_at)
       VALUES (31337, ?1, 90, ?2, 1, ?3, 0, 'Locked', ?4, 0, 0)`,
    )
      .bind(FAKE_ANCHOR, `0x${'b1'.repeat(32)}`, txHash, JSON.stringify({ roundKey: l.roundKey }))
      .run();
    await h.stub.submitLock([l]);
    await h.run();
    expect(h.fake.sent).toHaveLength(0);
    expect((await h.stub.status(l.roundKey)).lock).toMatchObject({ state: 'confirmed', txHash });
    expect(await lockTx(txHash)).toEqual([{ lock_tx: txHash, commit_tx: null }]);
  });

  it('N4: a sent lock that goes stuck inside its last 30 s stays in its replacement until closesAt', async () => {
    const h = await harness();
    const alerts = alertSpy();
    h.fake.automine = false;
    const a = lockItem(await insertRound(closeSec), closeSec);
    await h.stub.submitLock([a]);
    await h.run(); // v1
    h.at((closeSec - 20) * 1000); // stuck, and inside the 30 s margin
    await h.run();
    expect(h.fake.sent).toHaveLength(2);
    expect(
      decodeFunctionData({ abi: flockedAnchorAbi, data: h.fake.sent[1]!.data }).args[0],
    ).toEqual([a.roundKey]);
    expect((await h.stub.status(a.roundKey)).lock.state).toBe('sent');
    // Unconfirmed at its deadline: one alert; a late confirmation still counts.
    expect(alerts.codes()).toEqual(['ALERT_SCHEDULE_GAP']);
    h.fake.mine();
    await h.run();
    expect((await h.stub.status(a.roundKey)).lock).toMatchObject({
      state: 'confirmed',
      txHash: h.fake.sent[1]!.hash,
    });
  });
});
