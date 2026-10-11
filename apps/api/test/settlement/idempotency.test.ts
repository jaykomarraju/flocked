// NFR-6 (the settlement half): re-delivered settle and decrypt messages never double-count, and a
// re-run writes identical output. Bundle objects are write-once.
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queue } from '../../src/queues/index.js';
import { bundleChunkKey, manifestKey } from '../../src/settlement/keys.js';
import { alertSpy, atBeaconPlus, bundleObjects, harness, seedPicks } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const settleBatch = (roundId: string, ids: string[]) =>
  createMessageBatch(
    'settle',
    ids.map((id) => ({
      id,
      timestamp: new Date(),
      attempts: 1,
      body: { roundId, mode: 'free', idempotencyKey: `${roundId}:free` },
    })),
  );

describe('NFR-6 idempotent settlement', () => {
  it('NFR-6: re-delivered chunk messages are counted once', async () => {
    atBeaconPlus(5_000);
    const options = [0, 1, 1, 0, 1, 1, 1, 0, 1] as const;
    const r = await seedPicks(options);
    const h = await harness(r.roundId, { sizes: { decrypt: 2, bundle: 4 } });
    await h.start();
    const prepared = await h.alarm();
    expect(prepared).toMatchObject({ phase: 'decrypting', chunksTotal: 5 });
    const [m0, m1, ...rest] = h.sent;
    if (!m0 || !m1) throw new Error('no messages');
    // At-least-once delivery: chunk 0 three times, chunk 1 twice, interleaved.
    await h.deliver([m0, m1, m0, m1, m0]);
    expect(await h.stub.status()).toMatchObject({ phase: 'decrypting', chunksDone: 2 });
    await h.deliver(rest);
    expect(await h.stub.status()).toMatchObject({ phase: 'reducing', chunksDone: 5 });
    await h.deliver(h.sent); // every chunk again, after the last one
    expect((await h.stub.status()).chunksDone).toBe(5);

    expect(await h.alarm()).toMatchObject({ phase: 'done', chunksDone: 5 });
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]?.record).toMatchObject({ n: [3n, 6n], w: [30n, 60n] });
    expect(h.applied[0]?.entries).toHaveLength(options.length);

    // After done: more deliveries and another alarm change nothing.
    await h.deliver(h.sent);
    expect(await h.alarm()).toMatchObject({ phase: 'done', chunksDone: 5 });
    expect(h.applied).toHaveLength(1);
  });

  it('NFR-6: a re-delivered settle message starts one job', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1]);
    const h = await harness(r.roundId);
    const batch = settleBatch(r.roundId, ['a', 'b']);
    const ctx = createExecutionContext();
    await queue(batch, env, ctx);
    await queue(settleBatch(r.roundId, ['c']), env, createExecutionContext());
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['a', 'b']);
    expect(
      (
        await h.stub.start({
          roundId: r.roundId,
          mode: 'free',
          idempotencyKey: `${r.roundId}:free`,
        })
      ).started,
    ).toBe(false);
    await h.alarm();
    expect(h.sent).toHaveLength(1);
    await h.deliver();
    expect((await h.alarm()).phase).toBe('done');
    expect(h.applied).toHaveLength(1);
  });

  it('a settle message for an unknown round or key is retried into the DLQ, not dropped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await seedPicks([0, 1]);
    const batch = createMessageBatch('settle', [
      {
        id: 'unknown-round',
        timestamp: new Date(),
        attempts: 1,
        body: {
          roundId: '01J00000000000000000000000',
          mode: 'free',
          idempotencyKey: '01J00000000000000000000000:free',
        },
      },
      {
        id: 'bad-key',
        timestamp: new Date(),
        attempts: 1,
        body: { roundId: r.roundId, mode: 'free', idempotencyKey: 'something-else' },
      },
    ]);
    const ctx = createExecutionContext();
    await queue(batch, env, ctx);
    expect((await getQueueResult(batch, ctx)).retryMessages.map((m) => m.msgId)).toEqual([
      'unknown-round',
      'bad-key',
    ]);
  });
});

describe('bundle objects are write-once', () => {
  it('a re-run leaves every bundle object untouched and gives the same bundleHash', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1, 1, 0]);
    const first = await harness(r.roundId);
    expect((await first.run()).phase).toBe('done');
    const before = await env.BUCKET.list({ prefix: `bundles/${r.roundId}/` });
    const bytes = await bundleObjects(r.roundId);

    const again = await harness(r.roundId, { fresh: true });
    expect((await again.run()).phase).toBe('done');
    const after = await env.BUCKET.list({ prefix: `bundles/${r.roundId}/` });
    expect(after.objects.map((o) => [o.key, o.etag, o.uploaded.getTime()])).toEqual(
      before.objects.map((o) => [o.key, o.etag, o.uploaded.getTime()]),
    );
    expect(await bundleObjects(r.roundId)).toEqual(bytes);
    expect(again.applied[0]?.bundleHash).toBe(first.applied[0]?.bundleHash);
  });

  it('an existing object with other bytes is never replaced: the job fails and pages (ALERT-1)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1]);
    const squatter = new TextEncoder().encode('{"not":"this run"}');
    await env.BUCKET.put(manifestKey(r.roundId, 'free'), squatter);
    const alerts = alertSpy();
    const h = await harness(r.roundId);
    const status = await h.run();
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('already exists with different bytes');
    expect(alerts.codes()).toEqual(['ALERT_SETTLEMENT_FAILED']);
    expect(h.applied).toHaveLength(0);
    const kept = await env.BUCKET.get(manifestKey(r.roundId, 'free'));
    expect(new Uint8Array(await (kept as R2ObjectBody).arrayBuffer())).toEqual(squatter);
    // The chunk (written before the manifest) is this run's.
    expect(await env.BUCKET.head(bundleChunkKey(r.roundId, 'free', 0))).not.toBeNull();
  });
});
