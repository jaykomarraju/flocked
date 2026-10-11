// ALERT-1 (settlement failure or reconciliation mismatch) detection, ALERT_BEACON_LATE, and the
// beacon fetch: verification against the pinned key, relay rotation and the retry cadence.
// Paging on these codes is W13-A's.
import { env, runInDurableObject } from 'cloudflare:test';
import { QUICKNET } from '@flocked/tlock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettlementDO } from '../../src/do/settlement-do.js';
import {
  BEACON_FAST_RETRY_MS,
  BEACON_SLOW_RETRY_MS,
  QUICKNET_RELAYS,
  beaconRetryMs,
  fetchVerifiedBeacon,
  isBeaconLate,
  relaysFor,
} from '../../src/settlement/beacon.js';
import type { DecryptOutput } from '../../src/settlement/decrypt.js';
import { decryptOutputKey } from '../../src/settlement/keys.js';
import {
  BEACON,
  BEACON_TIME_MS,
  RELAYS,
  alertSpy,
  atBeaconPlus,
  fakeRelays,
  harness,
  modeStatus,
  seedPicks,
} from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const quiet = () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
};

/** ms until the DO's next alarm, without the manualAlarms hour. */
async function nextAlarmIn(stub: DurableObjectStub<SettlementDO>): Promise<number | null> {
  return runInDurableObject(stub, async (_o: SettlementDO, state) => {
    const at = await state.storage.getAlarm();
    return at === null ? null : at - Date.now() - 3_600_000;
  });
}

describe('ALERT-1 settlement failure or reconciliation mismatch', () => {
  it('ALERT-1: an anchored root that is not the tree over D1 fails before any decryption', async () => {
    quiet();
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1]);
    await env.DB.prepare(
      "UPDATE round_modes SET commitment_root = ?2 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(r.roundId, `0x${'ab'.repeat(32)}`)
      .run();
    const alerts = alertSpy();
    const h = await harness(r.roundId);
    await h.start();
    const status = await h.alarm();
    expect(status.phase).toBe('failed');
    expect(status.error).toMatch(/is not the tree over D1's entries/);
    expect(alerts.codes()).toEqual(['ALERT_SETTLEMENT_FAILED']);
    expect(h.sent).toEqual([]);
  });

  it('ALERT-1: a chunk whose output disagrees with its reported tally fails the reduce', async () => {
    quiet();
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1, 0, 1]);
    const h = await harness(r.roundId, { sizes: { decrypt: 2, bundle: 8 } });
    await h.start();
    await h.alarm();
    await h.deliver();
    // Tamper with chunk 1's stored output after its consumer reported.
    const key = decryptOutputKey(r.roundId, 'free', 1);
    const out = await (await env.BUCKET.get(key))?.json<DecryptOutput>();
    if (!out?.entries[0]) throw new Error('no output');
    out.entries[0].option = out.entries[0].option === 0 ? 1 : 0;
    await env.BUCKET.put(key, JSON.stringify(out));
    const alerts = alertSpy();
    const status = await h.alarm();
    expect(status).toMatchObject({ phase: 'failed' });
    expect(status.error).toMatch(/chunk 1: the reported tally does not match/);
    expect(alerts.codes()).toEqual(['ALERT_SETTLEMENT_FAILED']);
    expect(h.applied).toHaveLength(0);
  });

  it('ALERT-1: a step failing 5 times in a row pages once and keeps retrying with backoff', async () => {
    quiet();
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1]);
    const h = await harness(r.roundId);
    Object.assign(env, { DRAND_RELAYS: 'not a url' });
    const alerts = alertSpy();
    await h.start();
    const delays: (number | null)[] = [];
    for (let i = 0; i < 6; i++) {
      expect((await h.alarm()).phase).toBe('preparing');
      delays.push(await nextAlarmIn(h.stub));
    }
    expect((await h.stub.status()).error).toMatch(/DRAND_RELAYS/);
    expect(alerts.codes()).toEqual(['ALERT_SETTLEMENT_FAILED']);
    // 3 s, 6 s, 12 s, 24 s, 48 s, then capped at 60 s.
    expect(delays.map((d) => Math.round((d ?? 0) / 1000))).toEqual([3, 6, 12, 24, 48, 60]);
    atBeaconPlus(5_000);
    expect((await h.alarm()).phase).toBe('decrypting');
  });
});

describe('ALERT_BEACON_LATE and the beacon retry cadence', () => {
  it('retries every 3 s, alerts once 10 min after beacon time, then retries every 60 s', async () => {
    quiet();
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1]);
    let available = false;
    const relays = fakeRelays(() => (available ? 'ok' : 'missing'));
    const h = await harness(r.roundId, { relays });
    const alerts = alertSpy();
    await h.start();
    expect((await h.alarm()).phase).toBe('preparing');
    expect(await nextAlarmIn(h.stub)).toBeGreaterThan(BEACON_FAST_RETRY_MS - 500);
    expect(await nextAlarmIn(h.stub)).toBeLessThanOrEqual(BEACON_FAST_RETRY_MS);
    expect(await modeStatus(r.roundId)).toBe('pending');

    atBeaconPlus(599_000);
    await h.alarm();
    expect(alerts.codes()).toEqual([]);
    atBeaconPlus(600_000);
    await h.alarm();
    expect(alerts.codes()).toEqual(['ALERT_BEACON_LATE']);
    expect(await nextAlarmIn(h.stub)).toBeGreaterThan(BEACON_SLOW_RETRY_MS - 500);
    atBeaconPlus(660_000);
    await h.alarm();
    expect(alerts.codes()).toEqual(['ALERT_BEACON_LATE']);

    available = true;
    expect((await h.alarm()).phase).toBe('decrypting');
    expect(await modeStatus(r.roundId)).toBe('revealing');
  });

  it('waits for beacon time before asking any relay', async () => {
    atBeaconPlus(-30_000);
    const r = await seedPicks([0, 1]);
    const relays = fakeRelays(() => 'ok');
    const h = await harness(r.roundId, { relays });
    await h.start();
    expect((await h.alarm()).phase).toBe('preparing');
    expect(relays.calls).toEqual([]);
    expect(Math.round(((await nextAlarmIn(h.stub)) ?? 0) / 1000)).toBe(30);
  });

  it('stops without settling when the mode is no longer pending (rule 8 refunded it)', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1]);
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'refunded', refund_reason = 8, final_at = 1 WHERE round_id = ?1",
    )
      .bind(r.roundId)
      .run();
    const h = await harness(r.roundId);
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'failed', error: 'mode is refunded' });
    expect(h.sent).toEqual([]);
  });
});

describe('beacon fetch and verification', () => {
  const chain = QUICKNET;

  it('discards a bad signature or the wrong round and takes the next relay that verifies', async () => {
    for (const bad of ['bad_signature', 'wrong_round', 'missing', 'down'] as const) {
      const relays = fakeRelays((relay) => (relay === RELAYS[0] ? bad : 'ok'));
      const got = await fetchVerifiedBeacon({
        chain,
        round: BEACON.round,
        relays: RELAYS,
        fetch: relays.fetch,
      });
      expect(got.ok, bad).toBe(true);
      if (!got.ok) continue;
      expect(got.beacon).toEqual({ ...BEACON, relay: RELAYS[1] });
      expect(got.failures.map((f) => f.relay)).toEqual([RELAYS[0]]);
    }
  });

  it('fails the attempt when no relay has a signature that verifies for exactly beaconRound', async () => {
    const relays = fakeRelays(() => 'bad_signature');
    const got = await fetchVerifiedBeacon({
      chain,
      round: BEACON.round,
      relays: RELAYS,
      fetch: relays.fetch,
      start: 1,
    });
    expect(got.ok).toBe(false);
    expect(got.failures).toEqual([
      { relay: RELAYS[1], error: 'signature failed verification' },
      { relay: RELAYS[0], error: 'signature failed verification' },
    ]);
  });

  it('uses the configured relays, defaults to the public ones for quicknet, and needs them otherwise', () => {
    expect(relaysFor({ DRAND_RELAYS: ' https://a.test/ , https://b.test' }, chain)).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
    expect(relaysFor({}, chain)).toEqual([...QUICKNET_RELAYS]);
    expect(relaysFor({}, { ...chain, chainHash: 'ab'.repeat(32) })).toBeInstanceOf(Error);
    expect(relaysFor({ DRAND_RELAYS: 'ftp://x' }, chain)).toBeInstanceOf(Error);
  });

  it('retries every 3 s until beacon time + 10 min, every 60 s after', () => {
    const sec = BEACON_TIME_MS / 1000;
    expect(beaconRetryMs(BEACON_TIME_MS, sec)).toBe(3_000);
    expect(beaconRetryMs(BEACON_TIME_MS + 599_999, sec)).toBe(3_000);
    expect(beaconRetryMs(BEACON_TIME_MS + 600_000, sec)).toBe(60_000);
    expect(isBeaconLate(BEACON_TIME_MS + 599_999, sec)).toBe(false);
    expect(isBeaconLate(BEACON_TIME_MS + 600_000, sec)).toBe(true);
  });
});
