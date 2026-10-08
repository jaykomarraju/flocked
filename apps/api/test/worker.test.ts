// The Worker's non-HTTP entry points (queue consumers, cron triggers), its bindings, and
// wrangler.jsonc kept in step with the code (spec "Architecture").
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
} from 'cloudflare:test';
import { QUEUE_NAMES } from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRONS, CRON_JOBS, runCron } from '../src/cron.js';
import worker from '../src/index.js';
import { HANDLERS, logicalQueue, queue } from '../src/queues/index.js';
import type { WranglerSummary } from './env.js';
import { FIXTURE_IDS } from './helpers/index.js';

const WRANGLER = JSON.parse(env.TEST_WRANGLER) as WranglerSummary;

afterEach(() => {
  vi.restoreAllMocks();
});

const settle = {
  roundId: FIXTURE_IDS.round,
  mode: 'free',
  idempotencyKey: `${FIXTURE_IDS.round}:free`,
};
const msg = (id: string, body: unknown) => ({ id, timestamp: new Date(1_000), attempts: 1, body });

describe('queue consumers', () => {
  it('maps physical queue names to logical ones', () => {
    expect(logicalQueue('settle')).toBe('settle');
    expect(logicalQueue('decrypt-daily-staging')).toBe('decrypt-daily');
    expect(logicalQueue('notify-dlq')).toBeNull();
    expect(logicalQueue('other')).toBeNull();
  });

  it('acks a message its handler completes', async () => {
    const batch = createMessageBatch('settle-staging', [msg('m1', settle)]);
    const ctx = createExecutionContext();
    const handled = vi.fn((_body: unknown) => Promise.resolve());
    await queue(batch, env, ctx, { ...HANDLERS, settle: handled });
    const result = await getQueueResult(batch, ctx);
    expect(handled).toHaveBeenCalledOnce();
    expect(handled.mock.calls[0]?.[0]).toEqual(settle);
    expect(result.explicitAcks).toEqual(['m1']);
    expect(result.retryMessages).toEqual([]);
  });

  it('stub handlers retry valid messages; malformed ones are logged and acked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = createMessageBatch('settle', [
      msg('ok', settle),
      msg('bad', { roundId: 'nope', mode: 'free' }),
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(['ok']);
    expect(result.explicitAcks).toEqual(['bad']);
    expect(errors.mock.calls.some(([line]) => String(line).includes('queue_message_invalid'))).toBe(
      true,
    );
  });

  it.each([
    ['decrypt-daily', { roundId: FIXTURE_IDS.round, mode: 'free', chunkKey: 'chunks/r/free/0' }],
    ['decrypt-rooms', { roundId: FIXTURE_IDS.round, mode: 'free', chunkKey: 'chunks/r/free/0' }],
    [
      'cards',
      {
        roundId: FIXTURE_IDS.round,
        mode: 'free',
        userId: FIXTURE_IDS.user,
        kind: 'result',
        variants: ['og'],
      },
    ],
  ])('%s validates with the shared schema and dispatches', async (name, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const batch = createMessageBatch(name, [msg('a', body)]);
    const ctx = createExecutionContext();
    await queue(batch, env, ctx);
    expect((await getQueueResult(batch, ctx)).retryMessages.map((m) => m.msgId)).toEqual(['a']);
  });

  it('retries a batch from a queue it does not know', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = createMessageBatch('mystery', [msg('x', {})]);
    const ctx = createExecutionContext();
    await queue(batch, env, ctx);
    expect((await getQueueResult(batch, ctx)).retryBatch.retry).toBe(true);
  });
});

describe('cron triggers', () => {
  it('runs the jobs for each wrangler cron', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCron(CRONS.everyMinute, env, 0)).toEqual(['scheduler_tick', 'indexer_kick']);
    expect(await runCron(CRONS.hourly, env, 0)).toEqual(['create_rounds_ahead']);
    expect(await runCron(CRONS.nightly, env, 0)).toEqual(['reconcile_points']);
  });

  it('the scheduled export accepts every configured cron', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = createExecutionContext();
    for (const cron of WRANGLER.local.crons) {
      await worker.scheduled(
        createScheduledController({ cron, scheduledTime: Date.now() }),
        env,
        ctx,
      );
    }
    expect(warn).not.toHaveBeenCalled();
    expect(logs).toHaveBeenCalled();
    await worker.scheduled(createScheduledController({ cron: '5 5 5 5 5' }), env, ctx);
    expect(warn).toHaveBeenCalled();
  });
});

describe('bindings', () => {
  it('D1, R2 and KV work', async () => {
    expect(await env.DB.prepare('SELECT 1 AS one').first()).toEqual({ one: 1 });
    await env.BUCKET.put('k', 'v');
    expect(await (await env.BUCKET.get('k'))?.text()).toBe('v');
    await env.KV.put('k', 'v', { expirationTtl: 300 });
    expect(await env.KV.get('k')).toBe('v');
  });

  it('queues, Analytics Engine, email and assets are bound', () => {
    for (const q of [
      env.QUEUE_SETTLE,
      env.QUEUE_DECRYPT_DAILY,
      env.QUEUE_DECRYPT_ROOMS,
      env.QUEUE_CARDS,
      env.QUEUE_NOTIFY,
    ]) {
      expect(typeof q.send).toBe('function');
      expect(typeof q.sendBatch).toBe('function');
    }
    expect(() =>
      env.ANALYTICS.writeDataPoint({ blobs: ['test'], doubles: [1], indexes: ['t'] }),
    ).not.toThrow();
    expect(typeof env.EMAIL.send).toBe('function');
    expect(typeof env.ASSETS.fetch).toBe('function');
    // No local simulator: present, but unusable without remote bindings (see vitest.config.ts).
    expect(env.AI).toBeDefined();
    expect(env.VECTORIZE).toBeDefined();
  });

  it('local vars', () => {
    expect(env.ENVIRONMENT).toBe('local');
    expect(env.CHAIN_ID).toBe('31337');
    expect(env.DRAND_GENESIS).toBe('1692803367');
    expect(env.DRAND_PERIOD).toBe('3');
  });
});

describe('wrangler.jsonc stays in step with the code', () => {
  const envs = Object.entries(WRANGLER);
  const expectedDOs = [
    ['ROUND', 'RoundDO'],
    ['ROUND_VIEWER', 'RoundViewerDO'],
    ['ANCHOR', 'AnchorDO'],
    ['SETTLEMENT', 'SettlementDO'],
    ['AUTH', 'AuthDO'],
    ['RATE_LIMIT', 'RateLimitDO'],
    ['INDEXER', 'IndexerDO'],
  ];

  it.each(envs)('%s: vars per plan 4.4', (name, w) => {
    const chain = { local: '31337', staging: '84532', production: '8453' }[name];
    expect(w.vars).toMatchObject({
      ENVIRONMENT: name,
      CHAIN_ID: chain,
      DRAND_CHAIN_HASH: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
      DRAND_GENESIS: '1692803367',
      DRAND_PERIOD: '3',
    });
  });

  it.each(envs)('%s: every DO class is bound and SQLite-backed', (_name, w) => {
    expect(w.durableObjects.map((b) => [b.name, b.className])).toEqual(expectedDOs);
    expect([...w.sqliteClasses].sort()).toEqual(expectedDOs.map(([, c]) => c).sort());
  });

  it.each(envs)('%s: crons match src/cron.ts', (_name, w) => {
    expect([...w.crons].sort()).toEqual(Object.keys(CRON_JOBS).sort());
  });

  it.each(envs)('%s: one producer and one consumer per logical queue', (_name, w) => {
    expect(w.producers.map((p) => logicalQueue(p.queue)).sort()).toEqual([...QUEUE_NAMES].sort());
    expect(w.consumers.map((c) => logicalQueue(c.queue)).sort()).toEqual([...QUEUE_NAMES].sort());
    for (const c of w.consumers) {
      expect(c.dead_letter_queue, c.queue).toBeTruthy();
      expect(c.max_retries, c.queue).toBeGreaterThan(0);
    }
  });

  it.each(envs)('%s: decrypt consumers use the spec settings (Architecture)', (_name, w) => {
    const decrypt = w.consumers.filter((c) => logicalQueue(c.queue)?.startsWith('decrypt-'));
    expect(decrypt).toHaveLength(2);
    for (const c of decrypt) {
      expect(c.max_batch_size).toBe(1);
      expect(c.max_concurrency).toBe(250);
    }
    expect(w.limits?.cpu_ms).toBe(60_000);
  });
});
