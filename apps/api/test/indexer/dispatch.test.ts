// Handler dispatch: each registered handler sees each event revision once, in chain order, across
// replays, reorgs and failures; a handler's D1 statements commit with its handled mark.
import { env } from 'cloudflare:test';
import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexOnce } from '../../src/indexer/core.js';
import {
  DISPATCH_ALERT_ATTEMPTS,
  dispatchPending,
  type DispatchResult,
} from '../../src/indexer/dispatch.js';
import { ANY_EVENT, HandlerRegistry } from '../../src/indexer/handlers.js';
import type { ChainEvent } from '../../src/indexer/types.js';
import { captureAlerts, FakeChain, lockedLog, storedEvents, useDeployment } from './helpers.js';

let seed = 200;
let chain: FakeChain;
let dep: ReturnType<typeof useDeployment>;
let registry: HandlerRegistry;
let captured: ReturnType<typeof captureAlerts>;

const index = () =>
  indexOnce({
    db: env.DB,
    rpc: chain,
    chainId: dep.chainId,
    targets: dep.targets,
    nowMs: Date.now(),
  });
const dispatch = (): Promise<DispatchResult> =>
  dispatchPending(env, registry, {
    chainId: dep.chainId,
    targets: dep.targets,
    rpc: chain,
    nowMs: Date.now(),
  });
const cycle = async () => {
  await index();
  return dispatch();
};

interface Seen {
  handler: string;
  txHash: Hex;
  removed: boolean;
  revision: number;
}

/** Registers handlers that record what they saw. */
function recorder(event: string, ...names: string[]): Seen[] {
  const seen: Seen[] = [];
  for (const name of names) {
    registry.register(event, name, (evt: ChainEvent) => {
      seen.push({
        handler: name,
        txHash: evt.txHash,
        removed: evt.removed,
        revision: evt.revision,
      });
      return Promise.resolve();
    });
  }
  return seen;
}

beforeEach(() => {
  captured = captureAlerts();
  chain = new FakeChain();
  dep = useDeployment(seed++);
  registry = new HandlerRegistry();
});
afterEach(() => vi.restoreAllMocks());

describe('idempotent dispatch', () => {
  it('runs each handler once per event across replayed ranges', async () => {
    const seen = recorder('Locked', 'a', 'b');
    const any = recorder(ANY_EVENT, 'any');
    chain.mine([lockedLog(dep.anchor, 1), lockedLog(dep.anchor, 2)]);
    expect(await cycle()).toMatchObject({ dispatched: 2, failed: null });
    expect(seen.map((s) => s.handler)).toEqual(['a', 'b', 'a', 'b']);
    expect(any).toHaveLength(2);

    // Replay: forget the position (as after a crash) and index and dispatch the same range again.
    await env.DB.prepare('DELETE FROM indexer_state WHERE chain_id = ?1').bind(dep.chainId).run();
    expect(await cycle()).toMatchObject({ dispatched: 0 });
    expect(await cycle()).toMatchObject({ dispatched: 0 });
    expect(seen).toHaveLength(4);
    expect(any).toHaveLength(2);
    const rows = await storedEvents(dep.chainId, dep.anchor);
    expect(rows.every((r) => r.dispatched_revision === 0)).toBe(true);
  });

  it("commits a handler's statements with its handled mark, once", async () => {
    registry.register('Locked', 'audit', (evt, e) =>
      Promise.resolve([
        e.DB.prepare(
          "INSERT INTO audit_log (id, actor, action, target, created_at) VALUES (?1, 'system', 'test_locked', ?2, 0)",
        ).bind(`${evt.txHash}:${evt.logIndex}`, dep.anchor),
      ]),
    );
    chain.mine([lockedLog(dep.anchor, 1)]);
    await cycle();
    await env.DB.prepare('DELETE FROM indexer_state WHERE chain_id = ?1').bind(dep.chainId).run();
    await cycle();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE target = ?1')
      .bind(dep.anchor)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('stops at a failing event, keeping order, and retries only the handlers that did not run', async () => {
    const seen = recorder('Locked', 'first');
    let failNext = true;
    registry.register('Locked', 'flaky', (evt) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('downstream unavailable'));
      }
      seen.push({ handler: 'flaky', txHash: evt.txHash, removed: false, revision: evt.revision });
      return Promise.resolve();
    });
    const block = chain.mine([lockedLog(dep.anchor, 1), lockedLog(dep.anchor, 2)]);
    const [e1, e2] = block.logs.map((l) => l.transactionHash);

    const r1 = await cycle();
    expect(r1).toMatchObject({ dispatched: 0, more: true });
    expect(r1.failed).toMatchObject({ txHash: e1, handler: 'flaky', attempts: 1 });
    expect(seen).toEqual([{ handler: 'first', txHash: e1, removed: false, revision: 0 }]);
    const [row1] = await storedEvents(dep.chainId, dep.anchor);
    expect(row1!.dispatched_revision).toBeNull();

    expect(await dispatch()).toMatchObject({ dispatched: 2, failed: null });
    expect(seen.map((s) => [s.handler, s.txHash])).toEqual([
      ['first', e1],
      ['flaky', e1],
      ['first', e2],
      ['flaky', e2],
    ]);
  });

  it('dispatches a reorged-out event as removed, and its return as a new revision', async () => {
    const seen = recorder('Locked', 'h');
    chain.mineEmpty(2);
    const txHash = chain.newTxHash();
    chain.mine([{ ...lockedLog(dep.anchor, 1), txHash }]); // block 3
    await cycle();
    chain.reorg(1);
    chain.mineEmpty(2);
    await cycle();
    chain.mine([{ ...lockedLog(dep.anchor, 1), txHash }]);
    await cycle();
    expect(seen).toEqual([
      { handler: 'h', txHash, removed: false, revision: 0 },
      { handler: 'h', txHash, removed: true, revision: 1 },
      { handler: 'h', txHash, removed: false, revision: 2 },
    ]);
    await cycle();
    expect(seen).toHaveLength(3);
  });

  it('a log removed before any handler saw it is never dispatched', async () => {
    const seen = recorder('Locked', 'h');
    chain.mineEmpty(2);
    chain.mine([lockedLog(dep.anchor, 1)]);
    await index();
    chain.reorg(1);
    chain.mineEmpty(2);
    await index();
    expect(await dispatch()).toMatchObject({ dispatched: 1, failed: null });
    expect(seen).toEqual([]);
    const [row] = await storedEvents(dep.chainId, dep.anchor);
    expect(row).toMatchObject({ removed: 1, revision: 1, dispatched_revision: 1 });
  });

  it(`raises ALERT_DO_ERROR once after ${DISPATCH_ALERT_ATTEMPTS} failures in a row`, async () => {
    registry.register('Locked', 'broken', () => Promise.reject(new Error('bug')));
    chain.mine([lockedLog(dep.anchor, 1)]);
    await index();
    for (let i = 0; i < DISPATCH_ALERT_ATTEMPTS + 2; i++) await dispatch();
    const alerts = captured.alerts.filter((a) => a.code === 'ALERT_DO_ERROR');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      source: 'indexer_dispatch',
      handler: 'broken',
      attempts: DISPATCH_ALERT_ATTEMPTS,
    });
  });

  it('dispatches at most `limit` rows per call', async () => {
    recorder('Locked', 'h');
    chain.mine([lockedLog(dep.anchor, 1), lockedLog(dep.anchor, 2), lockedLog(dep.anchor, 3)]);
    await index();
    const opts = { chainId: dep.chainId, targets: dep.targets, rpc: chain, nowMs: 0, limit: 2 };
    expect(await dispatchPending(env, registry, opts)).toMatchObject({ dispatched: 2, more: true });
    expect(await dispatchPending(env, registry, opts)).toMatchObject({
      dispatched: 1,
      more: false,
    });
  });
});

describe('HandlerRegistry', () => {
  it('rejects a name that already runs for the event', () => {
    const noop = () => Promise.resolve();
    registry.register('Locked', 'x', noop);
    expect(() => registry.register('Locked', 'x', noop)).toThrow(/already registered/);
    expect(() => registry.register(ANY_EVENT, 'x', noop)).toThrow(/already registered/);
    registry.register(ANY_EVENT, 'y', noop);
    expect(() => registry.register('Committed', 'y', noop)).toThrow(/already registered/);
    registry.register('Committed', 'x', noop);
    expect(registry.for('Locked').map((h) => h.name)).toEqual(['y', 'x']);
  });
});
