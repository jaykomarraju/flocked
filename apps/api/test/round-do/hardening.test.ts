// RoundDO hardening from the W3-Z review (plan wave-4 "Carry-over from W3-Z", W4-D): a repeated init
// restarts a stalled alarm chain; a failing event backs off and ALERT_DO_ERROR is throttled; an
// identical replay after close returns the stored receipt; the commitment_root write is checked; a
// user short of points on a sealed round gets round_closed; an empty Free mode anchors nothing.
import { env, runInDurableObject } from 'cloudflare:test';
import type { SettleMessage } from '@flocked/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnchorDO } from '../../src/do/anchor-do.js';
import { eventRetryDelay } from '../../src/do/round-do.js';
import type { AnchorCommitItem } from '../../src/do/types.js';
import { captureAlerts } from '../indexer/helpers.js';
import {
  alarmAt,
  createRound,
  createUser,
  errCode,
  okValue,
  readMeta,
  sealedPick,
  setClock,
  useTestSigner,
  type TestRound,
} from './helpers.js';

const original = { QUEUE_SETTLE: env.QUEUE_SETTLE, QUEUE_NOTIFY: env.QUEUE_NOTIFY };
const realSubmitCommit = Object.getOwnPropertyDescriptor(AnchorDO.prototype, 'submitCommit');
let commits: AnchorCommitItem[];
let settleFails: boolean;
let settled: SettleMessage[];

beforeAll(() => {
  useTestSigner();
});

beforeEach(() => {
  commits = [];
  settled = [];
  settleFails = false;
  Object.defineProperty(AnchorDO.prototype, 'submitCommit', {
    configurable: true,
    writable: true,
    value(item: AnchorCommitItem) {
      commits.push(item);
      return Promise.resolve({ queued: [item.roundKey], alreadyAnchored: [] });
    },
  });
  Object.assign(env, {
    QUEUE_SETTLE: {
      send: (body: SettleMessage) => {
        if (settleFails) return Promise.reject(new Error('queue unavailable'));
        settled.push(body);
        return Promise.resolve();
      },
    },
    QUEUE_NOTIFY: { send: () => Promise.resolve(), sendBatch: () => Promise.resolve() },
  });
});

afterEach(() => {
  Object.assign(env, original);
  if (realSubmitCommit) Object.defineProperty(AnchorDO.prototype, 'submitCommit', realSubmitCommit);
});

async function enter(r: TestRound, userId: string, stake: string, ciphertext: string) {
  return r.stub.enterFree({ roundId: r.locked.roundId, userId, body: { stake, ciphertext } });
}

describe('RoundDO hardening', () => {
  it('a repeated init restarts a stalled alarm chain', async () => {
    const r = await createRound();
    setClock(r.locked.opensAt - 1_000);
    expect((await r.stub.init(r.locked)).status).toBe('scheduled');
    // The alarm is lost (say, a failed write) and the open time passes.
    await runInDurableObject(r.stub, (_i, state) => state.storage.deleteAlarm());
    setClock(r.locked.opensAt + 1_000);
    // The scheduler's next tick re-inits: the round opens without any alarm firing.
    expect((await r.stub.init(r.locked)).status).toBe('open');
    expect(
      await runInDurableObject(r.stub, (_i, state) => state.storage.getAlarm()),
    ).not.toBeNull();
  });

  it('a failing event backs off and ALERT_DO_ERROR is throttled per round and event', async () => {
    expect([1, 2, 3, 4, 7, 20].map(eventRetryDelay)).toEqual([
      10_000, 20_000, 40_000, 80_000, 600_000, 600_000,
    ]);
    const r = await createRound();
    setClock(r.locked.closesAt - 1_000);
    await r.stub.init(r.locked);
    await alarmAt(r.stub, r.locked.closesAt);
    const beaconAt = r.locked.beaconTimeSec * 1000;

    settleFails = true;
    const captured = captureAlerts();
    let t = beaconAt;
    const retryAts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await alarmAt(r.stub, t);
      const at = (await readMeta(r.stub))?.retryAt.settle as number;
      retryAts.push(at - t);
      t = at;
    }
    expect(retryAts).toEqual([10_000, 20_000, 40_000, 80_000]);
    const doAlerts = () =>
      captured.alerts.filter((a) => a.code === 'ALERT_DO_ERROR' && a.step === 'settle');
    expect(doAlerts()).toHaveLength(1);
    // Still failing 15 minutes after the first alert: one more.
    await alarmAt(r.stub, beaconAt + 15 * 60_000);
    expect(doAlerts()).toHaveLength(2);
    captured.restore();

    settleFails = false;
    await alarmAt(r.stub, (await readMeta(r.stub))?.retryAt.settle as number);
    const meta = await readMeta(r.stub);
    expect(meta?.done).toContain('settle');
    expect(settled).toHaveLength(1);
  });

  it('an identical replay after close returns the stored receipt', async () => {
    const r = await createRound();
    const scope = r.locked.roomId as string;
    setClock(r.locked.closesAt - 60_000);
    await r.stub.init(r.locked);
    const a = await createUser(100, scope);
    const ct = await sealedPick(r.locked, 1);
    const first = okValue(await enter(r, a, '25', ct));
    await alarmAt(r.stub, r.locked.closesAt);
    expect((await readMeta(r.stub))?.status).toBe('closed');

    const replay = okValue(await enter(r, a, '25', ct));
    expect(replay).toEqual(first);
    // Anything else is refused as closed, including the same user with another pick.
    expect(errCode(await enter(r, a, '30', ct))).toBe('round_closed');
    expect(errCode(await enter(r, a, '25', await sealedPick(r.locked, 0)))).toBe('round_closed');
    const b = await createUser(100, scope);
    expect(errCode(await enter(r, b, '25', ct))).toBe('round_closed');
  });

  it('alerts when the commitment_root write changes no row and the stored root differs', async () => {
    const r = await createRound();
    const scope = r.locked.roomId as string;
    setClock(r.locked.closesAt - 60_000);
    await r.stub.init(r.locked);
    okValue(await enter(r, await createUser(100, scope), '25', await sealedPick(r.locked)));
    await env.DB.prepare(
      "UPDATE round_modes SET commitment_root = ?2 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(r.locked.roundId, `0x${'00'.repeat(31)}01`)
      .run();
    const captured = captureAlerts();
    await alarmAt(r.stub, r.locked.closesAt);
    captured.restore();
    const root = (await readMeta(r.stub))?.freeClose?.root;
    expect(captured.alerts.filter((a) => a.step === 'commitment_root')).toEqual([
      expect.objectContaining({
        code: 'ALERT_DO_ERROR',
        stored: `0x${'00'.repeat(31)}01`,
        built: root,
      }),
    ]);
  });

  it('a user short of points on a sealed round gets round_closed, not insufficient_balance', async () => {
    // Short even with the room grant (5 + 100), so a wider stake range than the default.
    const r = await createRound({ free: { stakeMax: '500' } });
    const scope = r.locked.roomId as string;
    setClock(r.locked.closesAt - 60_000);
    await r.stub.init(r.locked);
    const poor = await createUser(5, scope);
    // Open in D1 too: the balance is the reason.
    expect(errCode(await enter(r, poor, '125', await sealedPick(r.locked)))).toBe(
      'insufficient_balance',
    );
    // D1 sealed (the DO has not run its close yet): the round is the reason.
    await env.DB.prepare("UPDATE rounds SET status = 'closed' WHERE id = ?1")
      .bind(r.locked.roundId)
      .run();
    expect(errCode(await enter(r, poor, '125', await sealedPick(r.locked)))).toBe('round_closed');
  });

  it('an empty Free mode skips the commit (rule 1, not rule 7)', async () => {
    const r = await createRound();
    setClock(r.locked.closesAt - 60_000);
    await r.stub.init(r.locked);
    await alarmAt(r.stub, r.locked.closesAt);
    expect((await readMeta(r.stub))?.freeClose).toMatchObject({
      root: null,
      entryCount: 0,
      anchor: 'none',
      nextAttemptAt: null,
    });
    const row = await env.DB.prepare(
      "SELECT commitment_root FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(r.locked.roundId)
      .first<{ commitment_root: string | null }>();
    expect(row?.commitment_root).toBeNull();
    await alarmAt(r.stub, r.locked.closesAt + 60_000);
    expect(commits).toEqual([]);
  });
});
