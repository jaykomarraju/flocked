// IndexerDO: poll and status over a scripted chain, the fast-poll alarm window (closesAt − 5 min until
// the Stakes proposal), ALERT-4 (lag over 150 s), joined concurrent polls, and the cron kick.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INDEXER_SINGLETON, LAG_ALERT_REPEAT_MS, type IndexerDO } from '../../src/do/indexer-do.js';
import { indexerKick } from '../../src/indexer/cron.js';
import { HandlerRegistry } from '../../src/indexer/handlers.js';
import {
  CRON_PERIOD_MS,
  FAST_POLL_MS,
  FAST_WINDOW_LEAD_MS,
  FAST_WINDOW_MAX_MS,
} from '../../src/indexer/schedule.js';
import { captureAlerts, FakeChain, lockedLog, useDeployment } from './helpers.js';

let seed = 400;
let chain: FakeChain;
let dep: ReturnType<typeof useDeployment>;
let captured: ReturnType<typeof captureAlerts>;

const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);
const setClock = (ms: number) => Object.assign(env, { FLOCKED_TEST_CLOCK: String(ms) });

/** A fresh IndexerDO wired to the scripted chain, with no handlers. */
async function indexer(name = `indexer-test-${seed}`, registry = new HandlerRegistry()) {
  const stub = env.INDEXER.get(env.INDEXER.idFromName(name));
  await runInDurableObject(stub, (instance: IndexerDO) => {
    instance.rpcFactory = () => chain;
    instance.registry = registry;
  });
  return stub;
}

beforeEach(() => {
  captured = captureAlerts();
  chain = new FakeChain(T0 / 1000);
  dep = useDeployment(seed++);
  Object.assign(env, { LOCAL_DEPLOYMENT: dep.json });
  setClock(T0);
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete (env as { FLOCKED_TEST_CLOCK?: string }).FLOCKED_TEST_CLOCK;
  delete (env as { LOCAL_DEPLOYMENT?: string }).LOCAL_DEPLOYMENT;
  // Rounds from the window tests must not open windows for later tests.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM round_modes'),
    env.DB.prepare('DELETE FROM rounds'),
  ]);
});

describe('poll and status', () => {
  it('mirrors the chain and reports its position', async () => {
    chain.mine([lockedLog(dep.anchor, 1)]);
    chain.mine([lockedLog(dep.anchor, 2)]);
    const stub = await indexer();
    expect(await stub.poll()).toEqual({ fromBlock: 1, toBlock: 2, events: 2, reorg: false });
    const s = await stub.status();
    expect(s).toMatchObject({ chainId: 31337, lagSec: 0, fastPolling: false, nextAlarmAt: null });
    const mine = s.contracts.filter((c) => c.contract === dep.anchor || c.contract === dep.escrow);
    expect(mine).toHaveLength(2);
    expect(
      mine.every((c) => c.lastBlockNumber === 2 && c.lastBlockHash === chain.blocks[2]!.hash),
    ).toBe(true);
    // Nothing new: the stored position.
    expect(await stub.poll()).toEqual({ fromBlock: 3, toBlock: 2, events: 0, reorg: false });
  });

  it('joins a poll that is already running', async () => {
    chain.mine([lockedLog(dep.anchor, 1)]);
    const stub = await indexer();
    let heads = 0;
    const real = chain.head.bind(chain);
    chain.head = () => {
      heads++;
      return real();
    };
    // Two calls in the same tick inside the object: the second always finds the first in flight.
    // (Two stub calls may not overlap at all on a loaded machine.)
    const [a, b] = await runInDurableObject(stub, (instance: IndexerDO) =>
      Promise.all([instance.poll(), instance.poll()]),
    );
    expect(a).toEqual({ fromBlock: 1, toBlock: 1, events: 1, reorg: false });
    expect(b).toBe(a);
    expect(heads).toBe(1);
  });

  it('reports a reorg', async () => {
    chain.mineEmpty(3);
    chain.mine([lockedLog(dep.anchor, 1)]);
    const stub = await indexer();
    await stub.poll();
    chain.reorg(2);
    chain.mineEmpty(3);
    expect(await stub.poll()).toMatchObject({ reorg: true, toBlock: chain.headNumber });
  });

  it('without an RPC URL it indexes nothing and says so', async () => {
    const stub = env.INDEXER.get(env.INDEXER.idFromName(`unconfigured-${seed}`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await stub.poll();
    expect(r.events).toBe(0);
    expect(warn.mock.calls.some(([l]) => String(l).includes('indexer_unconfigured'))).toBe(true);
  });
});

describe('fast polling', () => {
  const closesAt = T0 + 3_600_000;

  async function stakesRound(status: string) {
    const id = `01K7ROUND${String(seed).padStart(17, '0')}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rounds (id, kind, opens_at, closes_at, status) VALUES (?1, 'daily', ?2, ?3, 'open')",
      ).bind(id, closesAt - 86_400_000, closesAt),
      env.DB.prepare(
        "INSERT INTO round_modes (round_id, mode, status, chain_round_id, final_at) VALUES (?1, 'stakes', ?2, '1', ?3)",
      ).bind(id, status, ['settled', 'refunded', 'voided'].includes(status) ? closesAt : null),
    ]);
    return id;
  }

  async function alarmIn(stub: DurableObjectStub<IndexerDO>): Promise<number | null> {
    const before = Date.now();
    await stub.poll();
    const at = (await stub.status()).nextAlarmAt;
    return at === null ? null : at - before;
  }

  it('polls every few seconds from closesAt − 5 min until the proposal confirms', async () => {
    const id = await stakesRound('pending');
    const stub = await indexer();

    setClock(closesAt - FAST_WINDOW_LEAD_MS - 10 * 60_000); // window 10 min away: the cron covers it
    expect(await alarmIn(stub)).toBeNull();

    setClock(closesAt - FAST_WINDOW_LEAD_MS - 30_000); // opens in 30 s: alarm at the opening
    const toOpen = await alarmIn(stub);
    expect(toOpen).toBeGreaterThanOrEqual(30_000 - 1_000);
    expect(toOpen).toBeLessThanOrEqual(30_000 + 1_000);
    expect(30_000).toBeLessThan(CRON_PERIOD_MS);

    setClock(closesAt - 4 * 60_000); // inside the window
    const fast = await alarmIn(stub);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThanOrEqual(FAST_POLL_MS + 1_000);
    expect((await stub.status()).fastPolling).toBe(true);

    // The alarm polls and re-arms itself.
    chain.mine([lockedLog(dep.anchor, 1)]);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const s = await stub.status();
    expect(s.nextAlarmAt).not.toBeNull();
    expect(s.contracts.find((c) => c.contract === dep.anchor)?.lastBlockNumber).toBe(1);

    setClock(closesAt + 60_000); // after close, still waiting for the proposal
    expect(await alarmIn(stub)).not.toBeNull();

    // The indexer saw OutcomeProposed (a lifecycle handler moved the mode on): the window closes.
    await env.DB.prepare("UPDATE round_modes SET status = 'settle_proposed' WHERE round_id = ?1")
      .bind(id)
      .run();
    expect(await alarmIn(stub)).toBeNull();
    expect((await stub.status()).fastPolling).toBe(false);
  });

  it('falls back to the cron when a proposal never confirms', async () => {
    await stakesRound('revealing');
    const stub = await indexer();
    setClock(closesAt + FAST_WINDOW_MAX_MS - 1_000);
    expect(await alarmIn(stub)).not.toBeNull();
    setClock(closesAt + FAST_WINDOW_MAX_MS);
    expect(await alarmIn(stub)).toBeNull();
  });

  it('ignores Free modes and finished Stakes modes', async () => {
    const id = await stakesRound('refunded');
    await env.DB.prepare(
      "INSERT INTO round_modes (round_id, mode, status) VALUES (?1, 'free', 'pending')",
    )
      .bind(id)
      .run();
    const stub = await indexer();
    setClock(closesAt - 60_000);
    expect(await alarmIn(stub)).toBeNull();
  });
});

describe('ALERT-4: indexer lag over 150 s', () => {
  const lagAlerts = () => captured.alerts.filter((a) => a.code === 'ALERT_INDEXER_LAG');

  it('alerts while catching up more than 150 s behind the head, at most every 5 minutes', async () => {
    chain.mineEmpty(100); // 2 s blocks: the head is 200 s after block 0
    const stub = await indexer();
    await runInDurableObject(stub, (instance: IndexerDO) => {
      instance.indexOptions = { maxBlocksPerPoll: 10 };
    });
    await stub.poll(); // indexed to block 10: 180 s behind
    expect(lagAlerts()).toHaveLength(1);
    expect(lagAlerts()[0]).toMatchObject({ lagSec: 180, rpcFailing: false, severity: 'warn' });
    expect((await stub.status()).lagSec).toBe(180);

    setClock(T0 + 60_000);
    await stub.poll(); // block 20: 160 s behind, alerted a minute ago
    expect(lagAlerts()).toHaveLength(1);

    setClock(T0 + LAG_ALERT_REPEAT_MS + 60_000);
    await stub.poll(); // block 30: 140 s, under the threshold
    expect(lagAlerts()).toHaveLength(1);
    expect((await stub.status()).lagSec).toBe(140);
  });

  it("counts the head's own age, so a provider stuck on an old head alerts (not on the local stack)", async () => {
    chain.mine([lockedLog(dep.anchor, 1)]); // the head: T0 + 2 s
    const stub = await indexer();
    const local = await indexer(`indexer-local-${seed}`); // headAgeLag left to ENVIRONMENT (local)
    await runInDurableObject(stub, (instance: IndexerDO) => {
      instance.headAgeLag = true;
    });
    setClock(T0 + 2_000);
    await stub.poll();
    await local.poll();
    expect(lagAlerts()).toEqual([]);
    expect((await stub.status()).lagSec).toBe(0);

    // The provider keeps answering with the same head while the clock moves on 200 s.
    setClock(T0 + 202_000);
    await stub.poll();
    expect(lagAlerts()).toHaveLength(1);
    expect(lagAlerts()[0]).toMatchObject({ lagSec: 200, headAgeSec: 200, rpcFailing: false });
    expect((await stub.status()).lagSec).toBe(200);
    // anvil mines no empty blocks: locally an old head is normal.
    await local.poll();
    expect(lagAlerts()).toHaveLength(1);
    expect((await local.status()).lagSec).toBe(0);
  });

  it('alerts when the RPC has been failing for more than 150 s', async () => {
    chain.mine([lockedLog(dep.anchor, 1)]);
    const stub = await indexer();
    await stub.poll();
    chain.down = new Error('fetch failed');
    setClock(T0 + 100_000);
    await stub.poll();
    expect(lagAlerts()).toEqual([]);
    expect((await stub.status()).lagSec).toBe(100);
    setClock(T0 + 151_000);
    expect(await stub.poll()).toEqual({ fromBlock: 2, toBlock: 1, events: 0, reorg: false });
    expect(lagAlerts()).toHaveLength(1);
    expect(lagAlerts()[0]).toMatchObject({ lagSec: 151, rpcFailing: true, error: 'fetch failed' });

    chain.down = null;
    setClock(T0 + 200_000);
    await stub.poll();
    expect((await stub.status()).lagSec).toBe(0);
  });
});

describe('cron', () => {
  it('indexerKick polls the singleton', async () => {
    chain.mine([lockedLog(dep.anchor, 1)]);
    await indexer(INDEXER_SINGLETON);
    await indexerKick(env, T0);
    const s = await env.INDEXER.get(env.INDEXER.idFromName(INDEXER_SINGLETON)).status();
    expect(s.contracts.find((c) => c.contract === dep.anchor)?.lastBlockNumber).toBe(1);
  });
});
