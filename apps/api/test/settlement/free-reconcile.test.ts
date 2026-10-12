// The nightly point_balances vs points_ledger reconciliation (W5-D; spec "Data model" › Atomic
// points movements): clean after a settled Free round, and every drift found, page by page.
import { env } from 'cloudflare:test';
import { newUlid } from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRONS, runCron } from '../../src/cron.js';
import { reconcilePoints } from '../../src/jobs/reconcile.js';
import { GLOBAL_SCOPE, applyMovement, creditMovement } from '../../src/points/index.js';
import { alertSpy, atBeaconPlus, harness, seedPicks } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const db = () => env.DB;

async function credit(userId: string, amount: number, refId = newUlid()): Promise<void> {
  const out = await applyMovement(
    db(),
    creditMovement(db(), { userId, scope: GLOBAL_SCOPE, amount, reason: 'admin', refId, now: 1 }),
  );
  expect(out.status).toBe('applied');
}

describe('reconcilePoints', () => {
  it('finds nothing after a settled Free round, and runs on the nightly cron', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1, 0, 1]);
    const h = await harness(r.roundId, { apply: 'real' });
    expect(await h.run()).toMatchObject({ phase: 'done' });
    const alerts = alertSpy();
    const report = await reconcilePoints(env);
    expect(report.mismatches).toEqual([]);
    expect(report.users).toBeGreaterThanOrEqual(2);
    expect(await runCron(CRONS.nightly, env, 0)).toEqual(['reconcile_points']);
    expect(alerts.codes()).toEqual([]);
  });

  it('pages on a drifted balance and on ledger rows without a balance, on any page', async () => {
    // Users sort by ULID, i.e. by creation: the ledger-only user comes after every balance row,
    // so only the open-ended last page can see it.
    const users = Array.from({ length: 7 }, (_, i) => newUlid(Date.now() + i));
    for (const u of users.slice(0, 6)) await credit(u, 50);
    await db()
      .prepare('UPDATE point_balances SET balance = balance + 7 WHERE user_id = ?1')
      .bind(users[3])
      .run();
    const orphan = users[6] as string;
    await db()
      .prepare(
        "INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) VALUES (?1, ?2, 'global', 12, 'admin', 'x', 1)",
      )
      .bind(newUlid(), orphan)
      .run();

    const alerts = alertSpy();
    for (const pageSize of [2, 3, 500]) {
      const report = await reconcilePoints(env, { pageSize });
      expect(report.mismatches).toEqual([
        { userId: users[3], scope: GLOBAL_SCOPE, balance: 57, ledgerSum: 50 },
        { userId: orphan, scope: GLOBAL_SCOPE, balance: 0, ledgerSum: 12 },
      ]);
    }
    expect(alerts.codes()).toEqual([
      'ALERT_SETTLEMENT_FAILED',
      'ALERT_SETTLEMENT_FAILED',
      'ALERT_SETTLEMENT_FAILED',
    ]);
  });
});
