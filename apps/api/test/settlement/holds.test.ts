// ALERT-5 (anomalous VOID rate): the settlement holds and alerts instead of posting. Holds of either
// kind (void_rate, and a foreign Stakes entry's) keep the apply hook from running until the
// guardian's admin action releases them (W11-A). Stakes also waits for the safe-head flag (W6-A).
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anomalousVoidRate } from '../../src/settlement/void-rate.js';
import {
  alertSpy,
  atBeaconPlus,
  harness,
  pick,
  seedFreeRound,
  seedStakesRound,
} from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const garbage = () => ({ ct: new TextEncoder().encode('not an age file') });

async function holds(roundId: string) {
  const { results } = await env.DB.prepare(
    'SELECT mode, reason, tx_hash, released_at FROM settlement_holds WHERE round_id = ?1',
  )
    .bind(roundId)
    .all();
  return results;
}

async function release(roundId: string, mode: string, reason: string) {
  await env.DB.prepare(
    "UPDATE settlement_holds SET released_at = 1, released_by = 'guardian-admin' WHERE round_id = ?1 AND mode = ?2 AND reason = ?3",
  )
    .bind(roundId, mode, reason)
    .run();
}

describe('ALERT-5 anomalous VOID rate', () => {
  it('ALERT-5: more than 2 % VOIDs and at least 10 hold the settlement and alert, until released', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    atBeaconPlus(5_000);
    const r = await seedFreeRound(async (roundId) => [
      { ct: await pick(roundId, 0) },
      { ct: await pick(roundId, 1) },
      { ct: await pick(roundId, 1) },
      ...Array.from({ length: 10 }, garbage),
    ]);
    const alerts = alertSpy();
    const h = await harness(r.roundId, { sizes: { decrypt: 5, bundle: 20 } });
    const status = await h.run();
    expect(status).toMatchObject({ phase: 'applying', error: 'held:void_rate' });
    expect(alerts.codes()).toEqual(['ALERT_VOID_RATE']);
    const point = alerts.spy.mock.calls[0]?.[0] as AnalyticsEngineDataPoint | undefined;
    const data = JSON.parse(point?.blobs?.[3] as string) as Record<string, unknown>;
    expect(data).toMatchObject({ voids: 10, entries: 13, byReason: { non_canonical_header: 10 } });
    expect(await holds(r.roundId)).toEqual([
      { mode: 'free', reason: 'void_rate', tx_hash: null, released_at: null },
    ]);
    expect(h.applied).toHaveLength(0);

    // Still held: no second alert, no apply.
    expect((await h.alarm()).error).toBe('held:void_rate');
    expect(alerts.codes()).toEqual(['ALERT_VOID_RATE']);
    expect(h.applied).toHaveLength(0);

    await release(r.roundId, 'free', 'void_rate');
    expect(await h.alarm()).toMatchObject({ phase: 'done', error: null });
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]?.record.voidCount).toBe(10n);
  });

  it('ALERT-5: 9 VOIDs never hold, however high the rate', async () => {
    atBeaconPlus(5_000);
    const r = await seedFreeRound(async (roundId) => [
      { ct: await pick(roundId, 0) },
      ...Array.from({ length: 9 }, garbage),
    ]);
    const alerts = alertSpy();
    const h = await harness(r.roundId, { sizes: { decrypt: 5, bundle: 20 } });
    expect((await h.run()).phase).toBe('done');
    expect(alerts.codes()).toEqual([]);
    expect(await holds(r.roundId)).toEqual([]);
  });

  it('ALERT-5: the threshold is VOIDs > 2 % of entries and VOIDs ≥ 10', () => {
    expect(anomalousVoidRate(10, 499)).toBe(true);
    expect(anomalousVoidRate(10, 500)).toBe(false); // exactly 2 %
    expect(anomalousVoidRate(9, 9)).toBe(false);
    expect(anomalousVoidRate(12, 550)).toBe(true);
    expect(anomalousVoidRate(11, 550)).toBe(false);
  });
});

describe('Stakes holds and the safe head', () => {
  it('waits for the safe-head flag (stubbed false until W6-A) before decrypting', async () => {
    atBeaconPlus(5_000);
    const r = await seedStakesRound([0, 1, 1]);
    const h = await harness(r.roundId, { mode: 'stakes' });
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'preparing', chunksTotal: 0 });
    expect(await h.alarm()).toMatchObject({ phase: 'preparing', chunksTotal: 0 });
    expect(h.sent).toEqual([]);
  });

  it('never calls applyStakes while settlementHold(round, stakes) is open', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    atBeaconPlus(5_000);
    const r = await seedStakesRound([0, 1, 1]);
    await env.DB.prepare(
      "INSERT INTO settlement_holds (round_id, mode, reason, tx_hash, created_at) VALUES (?1, 'stakes', 'foreign_entry', ?2, 1)",
    )
      .bind(r.roundId, `0x${'f0'.repeat(32)}`)
      .run();
    const h = await harness(r.roundId, { mode: 'stakes', safeHead: true });
    const status = await h.run();
    expect(status).toMatchObject({ phase: 'applying', error: 'held:foreign_entry' });
    expect(h.applied).toHaveLength(0);
    expect((await h.alarm()).error).toBe('held:foreign_entry');
    expect(h.applied).toHaveLength(0);

    await release(r.roundId, 'stakes', 'foreign_entry');
    expect((await h.alarm()).phase).toBe('done');
    const result = h.applied[0];
    expect(result?.entries.map((e) => [e.account, e.option])).toEqual(
      r.wallets.map((w, i) => [w, [0, 1, 1][i]]),
    );
    // Three entries are fewer than the 20 Stakes needs: refund rule 1, so no payout tree.
    expect(result?.record).toMatchObject({ outcome: 'refunded', refundReason: 1 });
    expect(result?.manifest).toMatchObject({
      mode: 'stakes',
      chainRoundId: '7',
      payoutRoot: null,
      commitment: null,
    });
  });
});
