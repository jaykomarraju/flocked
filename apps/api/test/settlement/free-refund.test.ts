// SET-1b, refund rules 7 and 8 (W5-D; spec "Settlement and payout math" › Refund rules, "Round
// lifecycle" Mode (Free) pending → refunded). Rule 7 comes from the SettlementDO when the AnchorDO
// gave up on the commitment; rule 8 from the settle consumer's rule-8 job. Both are a conditional
// pending → refunded update first, then the refunds, so a mode that revealed is never refunded.
import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  runInDurableObject,
} from 'cloudflare:test';
import { roundKey } from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANCHOR_SINGLETON } from '../../src/chain/client.js';
import type { AnchorDO } from '../../src/do/anchor-do.js';
import { queue } from '../../src/queues/index.js';
import { rule8Key } from '../../src/rounds/schedule.js';
import { refundFree } from '../../src/settlement/apply/free.js';
import {
  BEACON_TIME_MS,
  alertSpy,
  atBeaconPlus,
  harness,
  modeStatus,
  recordedDeps,
  seedPicks,
  type SeededRound,
} from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const db = () => env.DB;

async function modeRow(roundId: string) {
  return db()
    .prepare(
      "SELECT status, refund_reason, final_at, revealed_at, bundle_hash FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
    )
    .bind(roundId)
    .first();
}

async function ledgerOf(roundId: string) {
  return (
    await db()
      .prepare(
        'SELECT user_id, reason, delta, created_at FROM points_ledger WHERE ref_id = ?1 ORDER BY user_id',
      )
      .bind(roundId)
      .all<{ user_id: string; reason: string; delta: number; created_at: number }>()
  ).results;
}

async function payoutsOf(roundId: string) {
  return (
    await db()
      .prepare('SELECT user_id, kind, amount FROM payouts WHERE round_id = ?1 ORDER BY user_id')
      .bind(roundId)
      .all<{ user_id: string; kind: string; amount: number }>()
  ).results;
}

async function balances(r: SeededRound): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (const e of r.entries) {
    const row = await db()
      .prepare("SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = 'global'")
      .bind(e.userId)
      .first<{ balance: number }>();
    out.push(row?.balance ?? null);
  }
  return out;
}

async function ciphertextsKept(roundId: string): Promise<number> {
  const row = await db()
    .prepare('SELECT COUNT(*) AS n FROM entries WHERE round_id = ?1 AND ciphertext IS NOT NULL')
    .bind(roundId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Every stake back as `refund` (payouts and ledger), once. */
async function expectRefunded(r: SeededRound, t: number) {
  const sorted = [...r.entries].sort((a, b) => (a.userId < b.userId ? -1 : 1));
  expect(await ledgerOf(r.roundId)).toEqual(
    sorted.map((e) => ({ user_id: e.userId, reason: 'refund', delta: e.stake, created_at: t })),
  );
  expect(await payoutsOf(r.roundId)).toEqual(
    sorted.map((e) => ({ user_id: e.userId, kind: 'refund', amount: e.stake })),
  );
  expect(await balances(r)).toEqual(r.entries.map((e) => e.stake));
}

/** The AnchorDO gave up on the round's commitment (its commit item is `failed`). */
async function commitFailed(roundId: string): Promise<void> {
  await db()
    .prepare("UPDATE round_modes SET commit_tx = NULL WHERE round_id = ?1 AND mode = 'free'")
    .bind(roundId)
    .run();
  const anchor = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
  await runInDurableObject(anchor, (o: AnchorDO, state) => {
    o.manualAlarms = true;
    state.storage.sql.exec(
      `INSERT INTO items (round_key, kind, round_id, item_json, state, due_sec, deadline_sec,
         beacon_round, alone, detail, alerted, created_at)
       VALUES (?, 'commit', ?, '{}', 'failed', 0, 0, 0, 1, 'deadline_passed', 1, 0)`,
      roundKey(roundId, 'free').toLowerCase(),
      roundId,
    );
  });
}

function rule8Batch(roundId: string, id = 'r8') {
  return createMessageBatch('settle', [
    {
      id,
      timestamp: new Date(),
      attempts: 1,
      body: { roundId, mode: 'free', idempotencyKey: rule8Key(roundId) },
    },
  ]);
}

describe('SET-1b rule 7: the commitment was not anchored before the beacon', () => {
  it('SET-1b rule 7: the SettlementDO refunds the pending mode once the AnchorDO gave up', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1], { mirror: false });
    await commitFailed(r.roundId);
    const h = await harness(r.roundId, { apply: 'real' });
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'done', error: null });

    const t = BEACON_TIME_MS + 5_000;
    expect(await modeRow(r.roundId)).toEqual({
      status: 'refunded',
      refund_reason: 7,
      final_at: t,
      revealed_at: null,
      bundle_hash: null,
    });
    await expectRefunded(r, t);
    expect(h.calls.results.map((c) => c.result)).toEqual([
      { outcome: 'refunded', reason: 7, provisional: false },
    ]);
    // Nothing was decrypted, so there is no bundle and nothing to anchor or archive.
    expect(h.sent).toEqual([]);
    expect(h.applied).toEqual([]);
    expect(h.calls.manifests).toEqual([]);
    expect(await ciphertextsKept(r.roundId)).toBe(3);
  });

  it('SET-1b rule 7: applies only while the mode is pending', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1]);
    await db()
      .prepare("UPDATE round_modes SET status = 'revealing' WHERE round_id = ?1")
      .bind(r.roundId)
      .run();
    const deps = recordedDeps();
    await refundFree(env, r.roundId, 7, deps.deps);
    expect(await modeStatus(r.roundId)).toBe('revealing');
    expect(await ledgerOf(r.roundId)).toEqual([]);
    expect(deps.results).toEqual([]);
  });
});

describe('SET-1b rule 8: the beacon is still unavailable 24 h after its round time', () => {
  it('SET-1b rule 8: the rule-8 job refunds a pending mode once, however often it is delivered', async () => {
    atBeaconPlus(24 * 3_600_000);
    const r = await seedPicks([0, 0, 1]);
    const alerts = alertSpy();
    for (const id of ['r8-a', 'r8-b']) {
      const batch = rule8Batch(r.roundId, id);
      const ctx = createExecutionContext();
      await queue(batch, env, ctx);
      expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual([id]);
    }
    const t = BEACON_TIME_MS + 24 * 3_600_000;
    expect(await modeRow(r.roundId)).toMatchObject({
      status: 'refunded',
      refund_reason: 8,
      final_at: t,
    });
    await expectRefunded(r, t);
    // No RoundDO was initialized here: an undeliverable result alerts instead of wedging the job.
    expect(alerts.codes()).toEqual(['ALERT_DO_ERROR', 'ALERT_DO_ERROR']);

    // A SettlementDO still waiting for the beacon stops without settling.
    const h = await harness(r.roundId, { apply: 'real' });
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'failed', error: 'mode is refunded' });
    expect(h.sent).toEqual([]);
  });

  it('SET-1b rule 8: is a conditional update; a mode that revealed is not refunded', async () => {
    atBeaconPlus(24 * 3_600_000);
    const r = await seedPicks([0, 1, 1]);
    await db()
      .prepare("UPDATE round_modes SET status = 'revealing' WHERE round_id = ?1")
      .bind(r.roundId)
      .run();
    const batch = rule8Batch(r.roundId);
    const ctx = createExecutionContext();
    await queue(batch, env, ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['r8']);
    expect(await modeStatus(r.roundId)).toBe('revealing');
    expect(await ledgerOf(r.roundId)).toEqual([]);
  });

  it('SET-1b rule 8: a failure after the update is retried without refunding twice', async () => {
    atBeaconPlus(24 * 3_600_000);
    const r = await seedPicks([0, 1, 1, 1]);
    const deps = recordedDeps();
    const notify = deps.deps.notifyRound;
    deps.deps.notifyRound = () => Promise.reject(new Error('RoundDO overloaded'));
    await expect(refundFree(env, r.roundId, 8, deps.deps)).rejects.toThrow('RoundDO overloaded');
    const t = BEACON_TIME_MS + 24 * 3_600_000;
    await expectRefunded(r, t);

    // The retry comes later; it keeps the first attempt's time and adds no rows.
    atBeaconPlus(25 * 3_600_000);
    deps.deps.notifyRound = notify;
    await refundFree(env, r.roundId, 8, deps.deps);
    await expectRefunded(r, t);
    expect(deps.results.map((c) => c.result)).toEqual([
      { outcome: 'refunded', reason: 8, provisional: false },
    ]);
  });
});
