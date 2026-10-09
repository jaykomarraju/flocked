// DO-5 (alarm-chain half): the RoundDO's single alarm slot walks open → streak_at_risk →
// closing_soon → close → settle at beacon time → Free rule 8 at beacon time + 24 h (spec "Real-time
// and the reveal" › RoundDO responsibilities). Queues and the AnchorDO are replaced with recorders.
import { env, runInDurableObject } from 'cloudflare:test';
import { roundKey, type SettleMessage } from '@flocked/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnchorDO } from '../../src/do/anchor-do.js';
import type { AnchorCommitItem } from '../../src/do/types.js';
import { roundEvents } from '../../src/rounds/schedule.js';
import {
  HOUR,
  alarmAt,
  createRound,
  createUser,
  readMeta,
  sealedPick,
  setClock,
  useTestSigner,
  type TestRound,
} from './helpers.js';

const original = {
  QUEUE_SETTLE: env.QUEUE_SETTLE,
  QUEUE_NOTIFY: env.QUEUE_NOTIFY,
};
// The AnchorDO stub runs in this isolate, so its method is patched (a fake ANCHOR binding would
// break runInDurableObject's binding checks).
const stubSubmitCommit = Object.getOwnPropertyDescriptor(AnchorDO.prototype, 'submitCommit');
let settled: SettleMessage[];
let commits: AnchorCommitItem[];
let anchorFailures: number;

beforeAll(() => {
  useTestSigner();
});

beforeEach(() => {
  settled = [];
  commits = [];
  anchorFailures = 0;
  Object.defineProperty(AnchorDO.prototype, 'submitCommit', {
    configurable: true,
    writable: true,
    value(item: AnchorCommitItem) {
      if (anchorFailures > 0) {
        anchorFailures--;
        return Promise.reject(new Error('anchor unavailable'));
      }
      commits.push(item);
      return Promise.resolve({ queued: [item.roundKey], alreadyAnchored: [] });
    },
  });
  Object.assign(env, {
    QUEUE_SETTLE: {
      send: (body: SettleMessage) => {
        settled.push(body);
        return Promise.resolve();
      },
    },
    QUEUE_NOTIFY: { send: () => Promise.resolve(), sendBatch: () => Promise.resolve() },
  });
});

const restoreAnchor = () => {
  if (stubSubmitCommit) Object.defineProperty(AnchorDO.prototype, 'submitCommit', stubSubmitCommit);
};

afterEach(() => {
  Object.assign(env, original);
  restoreAnchor();
});

const alarmTime = (r: TestRound) =>
  runInDurableObject(r.stub, (_i, state) => state.storage.getAlarm());

async function enterOne(r: TestRound, stake = '25'): Promise<void> {
  const u = await createUser(
    500,
    r.locked.kind === 'room' ? (r.locked.roomId as string) : 'global',
  );
  const res = await r.stub.enterFree({
    roundId: r.locked.roundId,
    userId: u,
    body: { stake, ciphertext: await sealedPick(r.locked) },
  });
  expect(res.ok).toBe(true);
}

describe('DO-5: the alarm chain', () => {
  it('runs every event in order, once, at its time', async () => {
    const r = await createRound({ kind: 'daily', modes: ['free', 'stakes'] });
    const l = r.locked;
    const beaconAt = l.beaconTimeSec * 1000;
    setClock(l.opensAt - 7 * HOUR);
    const state = await r.stub.init(l);
    expect(state).toMatchObject({ status: 'scheduled', roundId: l.roundId });
    // The alarm is set on the game clock: 7 hours of wall time from now.
    const wallBefore = Date.now();
    const at = (await alarmTime(r)) as number;
    expect(at - wallBefore).toBeGreaterThan(7 * HOUR - 5_000);
    expect(at - wallBefore).toBeLessThanOrEqual(7 * HOUR);

    // An early alarm runs nothing.
    await alarmAt(r.stub, l.opensAt - 1);
    expect((await readMeta(r.stub))?.done).toEqual([]);

    await alarmAt(r.stub, l.opensAt);
    expect((await readMeta(r.stub))?.done).toEqual(['open']);
    expect((await r.stub.getState()).status).toBe('open');
    const d1 = await env.DB.prepare('SELECT status FROM rounds WHERE id = ?1')
      .bind(l.roundId)
      .first<{ status: string }>();
    expect(d1?.status).toBe('open');
    await enterOne(r);

    await alarmAt(r.stub, l.closesAt - 3 * HOUR);
    expect((await readMeta(r.stub))?.done).toEqual(['open', 'streak_at_risk']);
    await alarmAt(r.stub, l.closesAt - HOUR);
    expect((await readMeta(r.stub))?.done).toEqual(['open', 'streak_at_risk', 'closing_soon']);

    await alarmAt(r.stub, l.closesAt);
    const closed = await readMeta(r.stub);
    expect(closed?.status).toBe('closed');
    expect(closed?.freeClose).toMatchObject({ entryCount: 1, totalStake: '25', anchor: 'queued' });
    expect(commits).toEqual([
      {
        roundKey: roundKey(l.roundId, 'free'),
        roundId: l.roundId,
        mode: 'free',
        root: closed?.freeClose?.root,
        entryCount: 1,
        totalStake: '25',
        closesAtSec: l.closesAt / 1000,
        beaconRound: l.beaconRound,
        beaconTimeSec: l.beaconTimeSec,
      },
    ]);
    expect(settled).toEqual([]);

    await alarmAt(r.stub, beaconAt - 1);
    expect(settled).toEqual([]);
    await alarmAt(r.stub, beaconAt);
    expect(settled).toEqual([
      { roundId: l.roundId, mode: 'free', idempotencyKey: `${l.roundId}:free` },
      { roundId: l.roundId, mode: 'stakes', idempotencyKey: `${l.roundId}:stakes` },
    ]);

    // Free still pending 24 h after the beacon time: the rule-8 job is enqueued.
    await alarmAt(r.stub, beaconAt + 24 * HOUR - 1);
    expect(settled).toHaveLength(2);
    await alarmAt(r.stub, beaconAt + 24 * HOUR);
    expect(settled[2]).toEqual({
      roundId: l.roundId,
      mode: 'free',
      idempotencyKey: `${l.roundId}:free:rule8`,
    });
    const done = (await readMeta(r.stub))?.done;
    expect(done).toEqual(roundEvents(l).map((e) => e.kind));
    expect(await alarmTime(r)).toBeNull();

    // A stray alarm afterwards changes nothing.
    await alarmAt(r.stub, beaconAt + 48 * HOUR);
    expect(settled).toHaveLength(3);
    expect(commits).toHaveLength(1);
  });

  it('rule 8 does nothing once the Free mode has left pending', async () => {
    const r = await createRound();
    const beaconAt = r.locked.beaconTimeSec * 1000;
    setClock(r.locked.closesAt + 1);
    await r.stub.init(r.locked);
    await alarmAt(r.stub, beaconAt);
    expect(settled.map((m) => m.idempotencyKey)).toEqual([`${r.locked.roundId}:free`]);
    await env.DB.prepare(
      "UPDATE round_modes SET status = 'settled', final_at = 1 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(r.locked.roundId)
      .run();
    await alarmAt(r.stub, beaconAt + 24 * HOUR);
    expect(settled).toHaveLength(1);
    expect((await readMeta(r.stub))?.done).toContain('rule8');
  });

  it('catches up on missed alarms in order (init after close)', async () => {
    const r = await createRound();
    setClock(r.locked.closesAt + 30_000);
    const state = await r.stub.init(r.locked);
    expect(state.status).toBe('closed');
    expect((await readMeta(r.stub))?.done).toEqual([
      'open',
      'streak_at_risk',
      'closing_soon',
      'close',
    ]);
    expect(settled).toEqual([]);
  });

  it('opens on the first entry if the open alarm is late', async () => {
    const r = await createRound();
    setClock(r.locked.opensAt - HOUR);
    await r.stub.init(r.locked);
    setClock(r.locked.opensAt + 1);
    await enterOne(r);
    expect((await r.stub.getState()).status).toBe('open');
  });

  it('retries a failed commit hand-off until the AnchorDO accepts it', async () => {
    const r = await createRound();
    setClock(r.locked.closesAt - 60_000);
    await r.stub.init(r.locked);
    await enterOne(r);
    anchorFailures = 2;
    await alarmAt(r.stub, r.locked.closesAt);
    expect((await readMeta(r.stub))?.freeClose).toMatchObject({
      anchor: 'retrying',
      nextAttemptAt: r.locked.closesAt + 5_000,
    });
    await alarmAt(r.stub, r.locked.closesAt + 5_000);
    expect((await readMeta(r.stub))?.freeClose?.anchor).toBe('retrying');
    await alarmAt(r.stub, r.locked.closesAt + 10_000);
    expect((await readMeta(r.stub))?.freeClose).toMatchObject({
      anchor: 'queued',
      nextAttemptAt: null,
    });
    expect(commits).toHaveLength(1);
  });

  it('gives up at the commit deadline: min(close + 90 s, beacon time − 30 s)', async () => {
    const r = await createRound();
    setClock(r.locked.closesAt - 60_000);
    await r.stub.init(r.locked);
    await enterOne(r);
    anchorFailures = 1_000;
    await alarmAt(r.stub, r.locked.closesAt);
    const deadline = (await readMeta(r.stub))?.freeClose?.deadline as number;
    expect(deadline).toBe(
      Math.min(r.locked.closesAt + 90_000, (r.locked.beaconTimeSec - 30) * 1000),
    );
    await alarmAt(r.stub, deadline);
    expect((await readMeta(r.stub))?.freeClose).toMatchObject({
      anchor: 'late',
      nextAttemptAt: null,
    });
    expect(commits).toEqual([]);
  });

  it('records not_implemented while the AnchorDO is a stub (real binding)', async () => {
    restoreAnchor();
    const r = await createRound();
    setClock(r.locked.closesAt - 60_000);
    await r.stub.init(r.locked);
    await enterOne(r);
    await alarmAt(r.stub, r.locked.closesAt);
    expect((await readMeta(r.stub))?.freeClose?.anchor).toBe('not_implemented');
  });

  it('init is idempotent for the same config and refuses a different one', async () => {
    const r = await createRound();
    setClock(r.locked.opensAt + HOUR);
    await r.stub.init(r.locked);
    expect((await r.stub.init(r.locked)).status).toBe('open');
    const err = await r.stub.init({ ...r.locked, closesAt: r.locked.closesAt + 1 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/^conflict/);
    const bad = await r.stub.init({ ...r.locked, beaconTimeSec: r.locked.beaconTimeSec + 3 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((bad as Error).message).toMatch(/beaconTimeSec/);
  });
});

describe('the event list', () => {
  it('skips notification times before opensAt and rule 8 without a Free mode', () => {
    const short = roundEvents({
      opensAt: 0,
      closesAt: 2 * HOUR,
      beaconTimeSec: 7_300,
      modes: ['stakes'],
    });
    expect(short.map((e) => e.kind)).toEqual(['open', 'closing_soon', 'close', 'settle']);
  });
});
