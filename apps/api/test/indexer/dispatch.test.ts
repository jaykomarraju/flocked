// Handler dispatch: each registered handler sees each event revision once, in chain order, across
// replays, reorgs and failures; removals go first, and only to handlers that saw what they undo; a
// handler's D1 statements commit with its handled mark; a stuck entry repeats its alert and doesn't
// silence ALERT-8.
import { env } from 'cloudflare:test';
import { newUlid, roundKey } from '@flocked/shared';
import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexOnce } from '../../src/indexer/core.js';
import {
  DISPATCH_ALERT_ATTEMPTS,
  DISPATCH_ALERT_REPEAT_MS,
  dispatchPending,
  type DispatchResult,
} from '../../src/indexer/dispatch.js';
import { ANY_EVENT, HandlerRegistry, registerBuiltinHandlers } from '../../src/indexer/handlers.js';
import { recordSentTx } from '../../src/indexer/sent.js';
import type { ChainEvent } from '../../src/indexer/types.js';
import { anchorConfirmationHandler } from '../../src/lifecycle/handlers.js';
import {
  anchorEvent,
  captureAlerts,
  escrowEvent,
  FakeChain,
  hash32,
  lockedLog,
  storedEvents,
  useDeployment,
} from './helpers.js';

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
const dispatch = (nowMs = Date.now()): Promise<DispatchResult> =>
  dispatchPending(env, registry, {
    chainId: dep.chainId,
    targets: dep.targets,
    rpc: chain,
    nowMs,
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

  it('repeats ALERT_DO_ERROR while an entry keeps failing', async () => {
    registry.register('Locked', 'broken', () => Promise.reject(new Error('bug')));
    chain.mine([lockedLog(dep.anchor, 1)]);
    await index();
    const t0 = Date.now();
    for (let i = 0; i < DISPATCH_ALERT_ATTEMPTS; i++) await dispatch(t0);
    await dispatch(t0 + DISPATCH_ALERT_REPEAT_MS - 1);
    expect(captured.alerts.filter((a) => a.code === 'ALERT_DO_ERROR')).toHaveLength(1);
    await dispatch(t0 + DISPATCH_ALERT_REPEAT_MS);
    await dispatch(t0 + DISPATCH_ALERT_REPEAT_MS + 1);
    const alerts = captured.alerts.filter((a) => a.code === 'ALERT_DO_ERROR');
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ handler: 'broken', attempts: DISPATCH_ALERT_ATTEMPTS + 2 });
  });

  it('a stuck entry does not silence ALERT-8 for the events behind it', async () => {
    registerBuiltinHandlers(registry);
    registry.register('Locked', 'broken', () => Promise.reject(new Error('bug')));
    const ours = chain.newTxHash();
    await recordSentTx(env, { chainId: dep.chainId, txHash: ours, kind: 'lock', roundKey: null });
    chain.mine([{ ...lockedLog(dep.anchor, 1), txHash: ours }]); // block 1: poison for 'broken'
    const foreign = chain.mine([
      escrowEvent(dep.escrow, 'Paused', { account: `0x${'33'.repeat(20)}` }),
    ]); // block 2: a guardian pause the backend didn't send
    const r = await cycle();
    expect(r.failed).toMatchObject({ handler: 'broken' });
    expect(r.independent).toBe(1);
    const unsent = captured.alerts.filter((a) => a.code === 'ALERT_FOREIGN_EVENT');
    expect(unsent).toEqual([
      expect.objectContaining({ eventName: 'Paused', txHash: foreign.logs[0]!.transactionHash }),
    ]);
    // Still stuck, and still once per event.
    await cycle();
    expect(captured.alerts.filter((a) => a.code === 'ALERT_FOREIGN_EVENT')).toHaveLength(1);
    const rows = await storedEvents(dep.chainId, dep.escrow);
    expect(rows[0]!.dispatched_revision).toBeNull();
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

describe('reorg order and per-handler removals', () => {
  it('a lock re-mined at a lower (block, logIndex) keeps lock_tx: the old removal goes first', async () => {
    registry.register('Locked', 'anchor-confirmation', anchorConfirmationHandler);
    const id = newUlid(Date.now());
    const closesAtSec = 1_900_000_000 + seed;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rounds (id, kind, opens_at, closes_at, status) VALUES (?1, 'daily', ?2, ?3, 'open')",
      ).bind(id, (closesAtSec - 86_400) * 1000, closesAtSec * 1000),
      env.DB.prepare(
        "INSERT INTO round_modes (round_id, mode, status) VALUES (?1, 'free', 'pending')",
      ).bind(id),
    ]);
    const lockTx = async () =>
      (
        await env.DB.prepare(
          "SELECT lock_tx FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
        )
          .bind(id)
          .first<{ lock_tx: string | null }>()
      )?.lock_tx;
    const txHash = chain.newTxHash();
    const lock = {
      ...anchorEvent(dep.anchor, 'Locked', {
        roundKey: roundKey(id, 'free'),
        closesAt: BigInt(closesAtSec),
        beaconRound: 1n,
        questionHash: hash32('q'),
        configHash: hash32('c'),
      }),
      txHash,
    };
    chain.mineEmpty(2);
    chain.mine([lockedLog(dep.anchor, 9), lock]); // block 3: the lock at log index 1
    await cycle();
    expect(await lockTx()).toBe(txHash);

    chain.reorg(2); // blocks 2..3 replaced
    chain.mine([lock]); // block 2, log index 0: a new row; (txHash, 1) is removed
    chain.mineEmpty(2);
    expect(await cycle()).toMatchObject({ failed: null });
    const rows = await storedEvents(dep.chainId, dep.anchor);
    expect(rows.filter((x) => x.tx_hash === txHash).map((x) => [x.log_index, x.removed])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(await lockTx()).toBe(txHash);
  });

  it('a slot that now holds another event is a removal for the old event and an addition for the new', async () => {
    const locked = recorder('Locked', 'l');
    const committed = recorder('Committed', 'c');
    const txHash = chain.newTxHash();
    chain.mineEmpty(2);
    chain.mine([{ ...lockedLog(dep.anchor, 1), txHash }]); // block 3, (txHash, 0)
    await cycle();
    chain.reorg(1);
    chain.mine([
      {
        ...anchorEvent(dep.anchor, 'Committed', {
          roundKey: hash32('round-key-1'),
          commitmentRoot: hash32('root'),
          entryCount: 1,
          totalStake: 0n,
        }),
        txHash,
      },
    ]); // block 3 again: the same slot is now a Committed
    chain.mineEmpty(1);
    await cycle();
    expect(locked).toEqual([
      { handler: 'l', txHash, removed: false, revision: 0 },
      { handler: 'l', txHash, removed: true, revision: 1 },
    ]);
    expect(committed).toEqual([{ handler: 'c', txHash, removed: false, revision: 2 }]);
  });

  it('a log re-mined in another block is undone and redone with the new block', async () => {
    const seen: [boolean, number, number][] = [];
    registry.register('Locked', 'blocks', (evt) => {
      seen.push([evt.removed, evt.blockNumber, evt.blockTimestampSec]);
      return Promise.resolve();
    });
    const txHash = chain.newTxHash();
    chain.mineEmpty(2);
    const b3 = chain.mine([{ ...lockedLog(dep.anchor, 1), txHash }]); // block 3, log index 0
    await cycle();
    chain.reorg(1);
    chain.mineEmpty(1);
    const b4 = chain.mine([{ ...lockedLog(dep.anchor, 1), txHash }]); // block 4, log index 0
    await cycle();
    expect(seen).toEqual([
      [false, 3, b3.timestamp],
      [true, 3, b3.timestamp],
      [false, 4, b4.timestamp],
    ]);
  });

  it('hands a removal only to the handlers that saw the addition it undoes', async () => {
    const seen = recorder('Locked', 'a');
    let failing = true;
    registry.register('Locked', 'b', (evt) => {
      if (failing) return Promise.reject(new Error('down'));
      seen.push({ handler: 'b', txHash: evt.txHash, removed: evt.removed, revision: evt.revision });
      return Promise.resolve();
    });
    chain.mineEmpty(2);
    const txHash = chain.newTxHash();
    chain.mine([{ ...lockedLog(dep.anchor, 1), txHash }]); // block 3
    expect(await cycle()).toMatchObject({ failed: { handler: 'b' } }); // 'a' saw it, 'b' didn't

    // A handler deployed later never saw the addition either.
    const late = recorder('Locked', 'late');
    failing = false;
    chain.reorg(1);
    chain.mineEmpty(2);
    expect(await cycle()).toMatchObject({ failed: null });
    expect(seen).toEqual([
      { handler: 'a', txHash, removed: false, revision: 0 },
      { handler: 'a', txHash, removed: true, revision: 1 },
    ]);
    expect(late).toEqual([]);
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
