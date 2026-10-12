// The settlement pipeline end to end inside workerd: the settle message through the real consumer,
// the SettlementDO's beacon fetch and verification, the decrypt fan-out through the real decrypt
// consumer, the reduce, the bundle in R2 and the apply hook.
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { queue } from '../../src/queues/index.js';
import { manifestKey } from '../../src/settlement/keys.js';
import type { BundleChunk, Manifest } from '../../src/settlement/types.js';
import { BEACON, atBeaconPlus, bundleObjects, harness, modeStatus, seedPicks } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const decode = <T>(b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as T;

describe('settlement pipeline (Free)', () => {
  it('a settle message produces a deterministic bundle in R2 and calls applyFree with a TallyResult', async () => {
    atBeaconPlus(5_000);
    const options = [0, 0, 1, 1, 1] as const;
    const r = await seedPicks(options);
    const h = await harness(r.roundId);

    const batch = createMessageBatch('settle', [
      {
        id: 'm1',
        timestamp: new Date(),
        attempts: 1,
        body: { roundId: r.roundId, mode: 'free', idempotencyKey: `${r.roundId}:free` },
      },
    ]);
    const ctx = createExecutionContext();
    await queue(batch, env, ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m1']);
    expect((await h.stub.status()).phase).toBe('preparing');

    const prepared = await h.alarm();
    expect(prepared).toMatchObject({ phase: 'decrypting', chunksTotal: 2, chunksDone: 0 });
    expect(await modeStatus(r.roundId)).toBe('revealing');
    expect(h.sent.map((m) => m.chunkKey)).toEqual([
      `settlement/${r.roundId}/free/in-0000.json`,
      `settlement/${r.roundId}/free/in-0001.json`,
    ]);

    await h.deliver();
    expect((await h.stub.status()).phase).toBe('reducing');
    const done = await h.alarm();
    expect(done).toMatchObject({ phase: 'done', chunksTotal: 2, chunksDone: 2, error: null });

    expect(h.applied).toHaveLength(1);
    const result = h.applied[0];
    if (!result) throw new Error('no result');
    expect(result.record).toMatchObject({
      outcome: 'settled',
      winner: 0,
      n: [2n, 3n],
      w: [20n, 30n],
      voidCount: 0n,
    });
    expect(result.entries.map((e) => [e.seq, e.entryId, e.userId, e.option])).toEqual(
      r.entries.map((e, seq) => [seq, e.id, e.userId, options[seq]]),
    );
    expect(result.entries.every((e) => e.nonce !== null && e.voidReason === null)).toBe(true);
    // Each winner takes an equal share of the 30-point loss pool; nothing is left for rebates.
    expect(result.payouts.map((p) => [p.kind, p.amount])).toEqual([
      ['win', 25n],
      ['win', 25n],
    ]);

    const objects = await bundleObjects(r.roundId);
    const manifestBytes = objects.get(manifestKey(r.roundId, 'free'));
    expect(manifestBytes).toEqual(result.manifestBytes);
    expect(result.bundleHash).toBe(keccak256(result.manifestBytes));
    const manifest = decode<Manifest>(result.manifestBytes);
    expect(manifest).toMatchObject({
      bundleFormat: 1,
      formulaVersion: 1,
      roundId: r.roundId,
      mode: 'free',
      beaconRound: BEACON.round,
      drand: { signature: BEACON.signature },
      commitment: { root: r.root, anchorTx: r.commitTx, entryCount: 5 },
      entryCount: 5,
      chunkSize: 8,
    });
    expect(manifest.chunks).toHaveLength(1);
    for (const c of manifest.chunks) {
      const bytes = objects.get(c.key);
      if (!bytes) throw new Error(`missing ${c.key}`);
      expect(keccak256(bytes)).toBe(c.hash);
      const chunk = decode<BundleChunk>(bytes);
      expect(chunk.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(chunk.entries[0]).toMatchObject({
        account: r.entries[0]?.userIdHash,
        stake: '10',
        valid: true,
        voidReason: null,
        commitment: r.entries[0]?.commitment,
      });
    }
  });

  it('runs the real applyFree, which settles the mode and anchors the manifest (W5-D)', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1]);
    const h = await harness(r.roundId, { apply: 'real' });
    const status = await h.run();
    expect(status).toMatchObject({ phase: 'done', error: null });
    expect((await bundleObjects(r.roundId)).size).toBe(2);
    expect(await modeStatus(r.roundId)).toBe('settled');
    expect(h.calls.results.map((c) => c.result.outcome)).toEqual(['revealed']);
    expect(h.calls.manifests.map((m) => m.manifestHash)).toEqual([h.applied[0]?.bundleHash]);
  });
});
