// The scheduler tick end to end against the fake chain: lock at opensAt − 6 h, the Free lock leaf
// through the AnchorDO (configHash = freeConfigHash), Stakes createRound with chain_round_id from the
// receipt, RoundDO.init, the Stakes fallback at opensAt, and schedule-gap detection (ALERT-6).
import { env } from 'cloudflare:test';
import {
  LOCKED_CONFIG_DEFAULTS,
  freeConfigHash,
  gameDayOf,
  roundKey,
  type LockedConfig,
} from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import { schedulerTick } from '../../src/scheduler/tick.js';
import { alertSpy } from '../anchor-do/helpers.js';
import {
  HOUR,
  MIN,
  chainHarness,
  insertQuestion,
  modeRows,
  roundRow,
  setClock,
} from './helpers.js';

afterEach(() => vi.restoreAllMocks());

const STAKES = {
  ...LOCKED_CONFIG_DEFAULTS.stakes,
  creator: '0x000000000000000000000000000000000000dead',
};

/** A daily round with a draft config; the clock and the chain sit `before` its lock. */
async function setup(gameDay: string, draft?: object) {
  const slot = dailySlot(gameDay);
  const id = (await insertDailyRound(env.DB, slot)) as string;
  const qId = await insertQuestion({ status: 'scheduled' });
  await env.DB.prepare('UPDATE rounds SET question_id = ?2, config_json = ?3 WHERE id = ?1')
    .bind(id, qId, draft ? JSON.stringify(draft) : null)
    .run();
  const lockAt = slot.opensAt - 6 * HOUR;
  const h = await chainHarness(lockAt);
  return { id, slot, lockAt, ...h };
}

describe('schedulerTick', () => {
  it('locks a Free round at opensAt − 6 h, anchors its lock leaf and initialises its RoundDO', async () => {
    const s = await setup('2027-04-02');
    setClock(s.lockAt - MIN);
    let report = await schedulerTick(env, s.deps);
    expect(report.locks[s.id]).toBeUndefined();
    expect((await roundRow(s.id)).locked_at).toBeNull();

    setClock(s.lockAt);
    report = await schedulerTick(env, s.deps);
    expect(report.locks[s.id]).toBe('locked');
    expect(report.lockLeaves).toContain(s.id);
    expect(report.initialized).toContain(s.id);

    await s.runAnchor(); // send
    await s.runAnchor(); // receipt
    const row = await roundRow(s.id);
    const onchain = s.fake.anchorOf(roundKey(s.id, 'free'));
    expect(onchain.configHash).toBe(freeConfigHash(JSON.parse(row.config_json!) as LockedConfig));
    expect(onchain.closesAt).toBe(BigInt(s.slot.closesAt / 1000));
    expect(onchain.beaconRound).toBe(BigInt(row.beacon_round!));
    const [free] = await modeRows(s.id);
    expect(free!.lock_tx).toBe(s.fake.sent[0]!.hash);

    const state = await env.ROUND.get(env.ROUND.idFromName(s.id)).getState();
    expect(state).toMatchObject({
      roundId: s.id,
      status: 'scheduled',
      opensAt: s.slot.opensAt,
      closesAt: s.slot.closesAt,
      beaconRound: row.beacon_round,
    });

    // The next tick changes nothing and sends nothing; the leaf is no longer submitted.
    setClock(s.lockAt + MIN);
    report = await schedulerTick(env, s.deps);
    expect(report.locks[s.id]).toBeUndefined();
    expect(report.lockLeaves).not.toContain(s.id);
    expect(await roundRow(s.id)).toEqual(row);
  });

  it('Stakes: createRound at lock stores chain_round_id from the receipt, once', async () => {
    const s = await setup('2027-04-03', {
      beaconDelay: 120,
      free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
      stakes: STAKES,
    });
    s.fake.roundCount = 41n; // the receipt's RoundCreated says 42
    setClock(s.lockAt);
    const report = await schedulerTick(env, s.deps);
    expect(report.stakes[s.id]).toBe('mined');
    const stakes = (await modeRows(s.id)).find((m) => m.mode === 'stakes')!;
    const createTx = s.fake.sent.find(
      (t) => t.to === '0xe5c0000000000000000000000000000000000e01',
    )!;
    expect(stakes).toMatchObject({
      status: 'pending',
      chain_round_id: '42',
      lock_tx: createTx.hash,
    });
    const op = await env.DB.prepare('SELECT status, tx_hash FROM operator_txs WHERE purpose = ?1')
      .bind(`createRound:${s.id}`)
      .first();
    expect(op).toEqual({ status: 'mined', tx_hash: createTx.hash });

    const state = await env.ROUND.get(env.ROUND.idFromName(s.id)).getState();
    expect(Object.keys(state.modes).sort()).toEqual(['free', 'stakes']);

    setClock(s.lockAt + MIN);
    await schedulerTick(env, s.deps);
    expect(s.fake.sent.filter((t) => t.to === createTx.to)).toHaveLength(1);
  });

  it('Stakes that cannot be created before opensAt is voided and alerts; Free goes on', async () => {
    const s = await setup('2027-04-04', {
      beaconDelay: 120,
      free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
      stakes: STAKES,
    });
    const alerts = alertSpy();
    const late = s.slot.opensAt + MIN; // the cron was down until after opensAt
    setClock(late);
    s.fake.time = late / 1000;
    const report = await schedulerTick(env, s.deps);
    expect(report.stakes[s.id]).toBe('refused');
    const stakes = (await modeRows(s.id)).find((m) => m.mode === 'stakes')!;
    expect(stakes).toMatchObject({ status: 'voided', chain_round_id: null });
    expect(alerts.codes()).toContain('ALERT_SCHEDULE_GAP');
    const state = await env.ROUND.get(env.ROUND.idFromName(s.id)).getState();
    expect(Object.keys(state.modes)).toEqual(['free']);
    expect(report.lockLeaves).toContain(s.id);
  });

  it('a daily round missing when it is due is a schedule gap: alert, then create it (ALERT-6)', async () => {
    const t = Date.UTC(2027, 4, 10, 16, 0, 0); // May 10, 12:00 EDT, nothing created ahead
    await chainHarness(t);
    setClock(t);
    const alerts = alertSpy();
    const report = await schedulerTick(env, {});
    expect(report.createdForGap).toHaveLength(1);
    const row = await roundRow(report.createdForGap[0]!);
    expect(gameDayOf(row.closes_at / 1000)).toBe('2027-05-10');
    expect(alerts.codes().filter((c) => c === 'ALERT_SCHEDULE_GAP').length).toBeGreaterThanOrEqual(
      1,
    );
    // The open round is past its lock, so the same tick locked it with a house question if any.
    expect(Object.keys(report.locks)).toContain(row.id);
    // Created once: the next tick finds it.
    setClock(t + MIN);
    expect((await schedulerTick(env, {})).createdForGap).toEqual([]);
  });
});
