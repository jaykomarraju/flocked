// applyFree (W5-D): the settlement's D1 outputs, the `revealed` transition, the RoundDO result, the
// manifest anchor and archival, run by the real SettlementDO from a real bundle; refund rules 1–3;
// NFR-6 (a re-run writes identical rows and no extra ledger rows); and a voided mode refunded once.
import { env } from 'cloudflare:test';
import { newUlid, roundKey } from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LockedRound } from '../../src/do/types.js';
import { applyVoid } from '../../src/lifecycle/void.js';
import { APPLY_SIZES, applyFree } from '../../src/settlement/apply/free.js';
import { IntegrityError } from '../../src/settlement/prepare.js';
import {
  BEACON_TIME_MS,
  atBeaconPlus,
  harness,
  modeStatus,
  pick,
  recordedDeps,
  seedFreeRound,
  seedPicks,
  voidCiphertexts,
  type SeededRound,
} from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const db = () => env.DB;

async function withSizes<T>(sizes: typeof APPLY_SIZES, fn: () => Promise<T>): Promise<T> {
  const saved = { ...APPLY_SIZES };
  Object.assign(APPLY_SIZES, sizes);
  try {
    return await fn();
  } finally {
    Object.assign(APPLY_SIZES, saved);
  }
}

async function all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> {
  return (
    await db()
      .prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}

async function modeRow(roundId: string) {
  return db()
    .prepare("SELECT * FROM round_modes WHERE round_id = ?1 AND mode = 'free'")
    .bind(roundId)
    .first<{
      status: string;
      refund_reason: number | null;
      bundle_hash: string | null;
      revealed_at: number | null;
      final_at: number | null;
    }>();
}

/** userId → [kind, amount] of its payouts row. */
async function payoutsOf(roundId: string): Promise<Map<string, [string, number]>> {
  const rows = await all<{ user_id: string; kind: string; amount: number }>(
    'SELECT user_id, kind, amount FROM payouts WHERE round_id = ?1',
    roundId,
  );
  return new Map(rows.map((r) => [r.user_id, [r.kind, r.amount]]));
}

async function ledgerOf(roundId: string) {
  return all<{ user_id: string; reason: string; delta: number; scope: string }>(
    'SELECT user_id, reason, delta, scope FROM points_ledger WHERE ref_id = ?1 ORDER BY user_id, reason',
    roundId,
  );
}

async function balanceOf(userId: string): Promise<number | null> {
  const row = await db()
    .prepare("SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = 'global'")
    .bind(userId)
    .first<{ balance: number }>();
  return row?.balance ?? null;
}

/** Every row applyFree writes or touches for the round, for NFR-6 comparisons. */
async function snapshot(r: SeededRound, extraUsers: string[] = []) {
  const users = [...r.entries.map((e) => e.userId), ...extraUsers];
  const marks = users.map((_, i) => `?${i + 1}`).join(', ');
  return {
    settlements: await all('SELECT * FROM settlements WHERE round_id = ?1', r.roundId),
    payouts: await all(
      'SELECT * FROM payouts WHERE round_id = ?1 ORDER BY user_id, kind',
      r.roundId,
    ),
    ledger: await all('SELECT * FROM points_ledger WHERE ref_id = ?1 ORDER BY id', r.roundId),
    balances: await all(
      `SELECT * FROM point_balances WHERE user_id IN (${marks}) ORDER BY user_id`,
      ...users,
    ),
    entries: await all(
      'SELECT id, option_index, valid, void_reason, ciphertext FROM entries WHERE round_id = ?1 ORDER BY id',
      r.roundId,
    ),
    mode: await all('SELECT * FROM round_modes WHERE round_id = ?1', r.roundId),
  };
}

/**
 * Winners on option 0 (2 × 10), losers on option 1 (100, 90, 70, 50, 33), one VOID of 25. The 10×
 * cap binds: each winner gets 10 + 100, R = 343 − 200 = 143 goes back to the losers pro rata
 * (41, 37, 29, 20, 13 = 140) and 3 is dust. The award is ⌊343 × 100 / 10000⌋ = 3.
 */
async function seedCapped(awardRecipient: string | null) {
  return seedFreeRound(
    async (id) => {
      const voids = await voidCiphertexts(id);
      return [
        { ct: await pick(id, 0), stake: 10 },
        { ct: await pick(id, 1), stake: 100 },
        { ct: await pick(id, 0), stake: 10 },
        { ct: await pick(id, 1), stake: 90 },
        { ct: await pick(id, 1), stake: 70 },
        { ct: voids.bad_option, stake: 25 },
        { ct: await pick(id, 1), stake: 50 },
        { ct: await pick(id, 1), stake: 33 },
      ];
    },
    { free: { awardRecipient } },
  );
}

const EXPECTED: [string, number][] = [
  ['win', 110],
  ['rebate', 41],
  ['win', 110],
  ['rebate', 37],
  ['rebate', 29],
  ['void_refund', 25],
  ['rebate', 20],
  ['rebate', 13],
];
const LEDGER_REASON: Record<string, string> = {
  win: 'payout',
  rebate: 'rebate',
  void_refund: 'void_refund',
  refund: 'refund',
};

describe('applyFree: a settled round', () => {
  it('writes the record, entries, payouts and ledger, settles the mode, notifies, anchors and archives', async () => {
    atBeaconPlus(5_000);
    const author = newUlid();
    const r = await seedCapped(author);
    const h = await harness(r.roundId, { apply: 'real' });
    // Two rows per statement and two statements per batch: several chunks and batches.
    const status = await withSizes({ chunk: 2, batch: 2 }, () => h.run());
    expect(status).toMatchObject({ phase: 'done', error: null });
    const result = h.applied[0];
    if (!result) throw new Error('no result');
    const t = BEACON_TIME_MS + 5_000;

    expect(await modeRow(r.roundId)).toMatchObject({
      status: 'settled',
      refund_reason: null,
      bundle_hash: result.bundleHash,
      revealed_at: t,
      final_at: t,
    });

    const [rec] = await all<Record<string, unknown>>(
      'SELECT * FROM settlements WHERE round_id = ?1',
      r.roundId,
    );
    expect(rec).toMatchObject({
      mode: 'free',
      proposal_seq: 0,
      outcome: 'settled',
      formula_version: 1,
      loss_pool: 343,
      fee: 0,
      creator_fee: 0,
      distributable: 343,
      rebate_pool: 143,
      dust: 3,
      payout_root: result.manifest.payoutRoot,
      manifest_r2_key: `bundles/${r.roundId}/free/manifest.json`,
      bundle_hash: result.bundleHash,
      settled_at: t,
      tx_hash: null,
      superseded_at: null,
    });
    expect(JSON.parse(rec?.tally_json as string)).toEqual([
      { headcount: 2, total: '20' },
      { headcount: 5, total: '343' },
    ]);
    expect(JSON.parse(rec?.winners_json as string)).toEqual({
      winner: 0,
      refundReason: null,
      voidCount: '1',
      voidStake: '25',
      total: '363',
      creatorAward: '3',
      awardRecipient: author,
    });

    // Entries: option, validity and VOID reason.
    const entries = await all<{
      id: string;
      option_index: number | null;
      valid: number;
      void_reason: string | null;
      ciphertext: ArrayBuffer | null;
    }>(
      'SELECT id, option_index, valid, void_reason, ciphertext FROM entries WHERE round_id = ?1 ORDER BY receipt_seq',
      r.roundId,
    );
    expect(entries.map((e) => [e.option_index, e.valid, e.void_reason])).toEqual([
      [0, 1, null],
      [1, 1, null],
      [0, 1, null],
      [1, 1, null],
      [1, 1, null],
      [null, 0, 'bad_option'],
      [1, 1, null],
      [1, 1, null],
    ]);
    // Archived: every ciphertext is in a bundle chunk now.
    expect(entries.every((e) => e.ciphertext === null)).toBe(true);

    // Payouts, ledger and balances per player; the author's award; dust credited to no one.
    const payouts = await payoutsOf(r.roundId);
    expect(r.entries.map((e) => payouts.get(e.userId))).toEqual(EXPECTED);
    const ledger = await ledgerOf(r.roundId);
    expect(ledger).toHaveLength(9);
    for (const [i, e] of r.entries.entries()) {
      const [kind, amount] = EXPECTED[i] as [string, number];
      expect(ledger.filter((l) => l.user_id === e.userId)).toEqual([
        { user_id: e.userId, reason: LEDGER_REASON[kind], delta: amount, scope: 'global' },
      ]);
      expect(await balanceOf(e.userId)).toBe(amount);
    }
    expect(ledger.filter((l) => l.user_id === author)).toEqual([
      { user_id: author, reason: 'creator_award', delta: 3, scope: 'global' },
    ]);
    expect(await balanceOf(author)).toBe(3);
    // The invariant with F = C = 0: payouts + dust = T + V.
    const paid = EXPECTED.reduce((s, [, a]) => s + a, 0);
    expect(paid + 3).toBe(363 + 25);

    // The RoundDO hears `revealed` once; the manifest goes to the AnchorDO.
    expect(h.calls.results).toEqual([
      {
        roundId: r.roundId,
        result: {
          outcome: 'revealed',
          winningOption: 0,
          tally: [
            { headcount: 2, total: '20' },
            { headcount: 5, total: '343' },
          ],
          bundleHash: result.bundleHash,
          revealedAt: t,
        },
      },
    ]);
    expect(h.calls.manifests).toEqual([
      {
        roundKey: roundKey(r.roundId, 'free'),
        roundId: r.roundId,
        mode: 'free',
        manifestHash: result.bundleHash,
        beaconTimeSec: BEACON_TIME_MS / 1000,
      },
    ]);
  });

  it('pays no creator award for a house question', async () => {
    atBeaconPlus(5_000);
    const r = await seedCapped(null);
    const h = await harness(r.roundId, { apply: 'real' });
    expect(await h.run()).toMatchObject({ phase: 'done' });
    const ledger = await ledgerOf(r.roundId);
    expect(ledger.map((l) => l.reason)).not.toContain('creator_award');
    expect(ledger).toHaveLength(8);
  });
});

describe('applyFree: refund rules 1–3', () => {
  it.each([
    ['rule 2 (one-sided)', [1, 1, 1] as const, 2],
    ['rule 3 (headcount tie)', [0, 1, 0, 1] as const, 3],
  ])(
    '%s refunds every stake, pays no award, and still anchors and archives',
    async (_n, options, rule) => {
      atBeaconPlus(5_000);
      const r = await seedPicks(options, { free: { awardRecipient: newUlid() } });
      const h = await harness(r.roundId, { apply: 'real' });
      expect(await h.run()).toMatchObject({ phase: 'done', error: null });
      const result = h.applied[0];
      expect(await modeRow(r.roundId)).toMatchObject({
        status: 'refunded',
        refund_reason: rule,
        bundle_hash: result?.bundleHash,
      });
      const payouts = await payoutsOf(r.roundId);
      expect(r.entries.map((e) => payouts.get(e.userId))).toEqual(
        r.entries.map(() => ['refund', 10]),
      );
      const ledger = await ledgerOf(r.roundId);
      expect(ledger.map((l) => [l.reason, l.delta])).toEqual(r.entries.map(() => ['refund', 10]));
      expect(h.calls.results.map((c) => c.result)).toEqual([
        { outcome: 'refunded', reason: rule, provisional: false, bundleHash: result?.bundleHash },
      ]);
      expect(h.calls.manifests).toHaveLength(1);
      const kept = await all(
        'SELECT id FROM entries WHERE round_id = ?1 AND ciphertext IS NOT NULL',
        r.roundId,
      );
      expect(kept).toEqual([]);
    },
  );

  it('rule 1: a mode with no entries refunds under rule 1 with an empty bundle, anchored', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([]);
    const h = await harness(r.roundId, { apply: 'real' });
    expect(await h.run()).toMatchObject({ phase: 'done', error: null });
    expect(await modeRow(r.roundId)).toMatchObject({ status: 'refunded', refund_reason: 1 });
    expect(await payoutsOf(r.roundId)).toEqual(new Map());
    expect(h.calls.results.map((c) => c.result.outcome)).toEqual(['refunded']);
    expect(h.calls.manifests).toHaveLength(1);
  });
});

describe('applyFree: NFR-6', () => {
  it('NFR-6: re-running apply yields identical rows and no extra ledger rows', async () => {
    atBeaconPlus(5_000);
    const author = newUlid();
    const r = await seedCapped(author);
    const h = await harness(r.roundId, { apply: 'real' });
    expect(await h.run()).toMatchObject({ phase: 'done' });
    const result = h.applied[0];
    if (!result) throw new Error('no result');
    const first = await snapshot(r, [author]);
    expect(first.ledger).toHaveLength(9);

    // A retry after it finished (a redelivery, or a restart before `done` was saved).
    atBeaconPlus(60_000);
    const deps = recordedDeps();
    await withSizes({ chunk: 3, batch: 1 }, () => applyFree(env, result, deps.deps));
    expect(await snapshot(r, [author])).toEqual(first);

    // A crash before the `revealing` → settled update: every write runs again, none counts twice.
    await db()
      .prepare(
        "UPDATE round_modes SET status = 'revealing', refund_reason = NULL, bundle_hash = NULL, revealed_at = NULL, final_at = NULL WHERE round_id = ?1 AND mode = 'free'",
      )
      .bind(r.roundId)
      .run();
    await applyFree(env, result, deps.deps);
    expect(await snapshot(r, [author])).toEqual(first);
    expect(deps.results).toHaveLength(2);
  });

  it('NFR-6: a step failing after the ledger is written is retried by the DO without crediting twice', async () => {
    atBeaconPlus(5_000);
    const r = await seedCapped(null);
    const h = await harness(r.roundId, { apply: 'real' });
    const notify = h.calls.deps.notifyRound;
    let failures = 1;
    h.calls.deps.notifyRound = (e, id, res) =>
      failures-- > 0 ? Promise.reject(new Error('RoundDO overloaded')) : notify(e, id, res);
    const failed = await h.run();
    expect(failed).toMatchObject({ phase: 'applying', error: 'RoundDO overloaded' });
    expect(await modeStatus(r.roundId)).toBe('settled');
    const before = await snapshot(r);

    expect(await h.alarm()).toMatchObject({ phase: 'done', error: null });
    // The same rows; only the archival, which the failed attempt never reached, is new.
    expect(await snapshot(r)).toEqual({
      ...before,
      entries: before.entries.map((e) => ({ ...e, ciphertext: null })),
    });
    expect(before.ledger).toHaveLength(8);
    for (const [i, e] of r.entries.entries()) {
      expect(await balanceOf(e.userId)).toBe((EXPECTED[i] as [string, number])[1]);
    }
    expect(h.calls.results).toHaveLength(1);
  });

  it('a different bundle for an applied mode is an integrity failure that writes nothing', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1]);
    const h = await harness(r.roundId, { apply: 'real' });
    expect(await h.run()).toMatchObject({ phase: 'done' });
    const result = h.applied[0];
    if (!result) throw new Error('no result');
    const before = await snapshot(r);
    const forged = { ...result, bundleHash: `0x${'ab'.repeat(32)}` as const };
    await expect(applyFree(env, forged, recordedDeps().deps)).rejects.toBeInstanceOf(
      IntegrityError,
    );
    expect(await snapshot(r)).toEqual(before);
  });
});

describe('applyFree: a voided mode (rule 4)', () => {
  it('is refunded once, at void confirmation: the settlement stops and applyFree refuses it', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1]);
    // The bundle exists (the record hook writes no D1), then the void is applied as RoundDO does.
    const h = await harness(r.roundId);
    expect(await h.run()).toMatchObject({ phase: 'done' });
    const result = h.applied[0];
    if (!result) throw new Error('no result');
    await db()
      .prepare("UPDATE round_modes SET status = 'pending' WHERE round_id = ?1")
      .bind(r.roundId)
      .run();
    const locked = { roundId: r.roundId, kind: 'daily', roomId: null, modes: ['free'] };
    await applyVoid(env, locked as unknown as LockedRound, BEACON_TIME_MS);
    const voided = await ledgerOf(r.roundId);
    expect(voided.map((l) => [l.reason, l.delta])).toEqual(
      r.entries.map(() => ['void_refund', 10]),
    );

    const deps = recordedDeps();
    await expect(applyFree(env, result, deps.deps)).rejects.toThrow(/is voided, not revealing/);
    expect(await ledgerOf(r.roundId)).toEqual(voided);
    expect(await payoutsOf(r.roundId)).toEqual(new Map());
    expect(await all('SELECT 1 FROM settlements WHERE round_id = ?1', r.roundId)).toEqual([]);
    expect(deps.results).toEqual([]);

    // A settle message after the void (none is sent, but a stray one) stops before revealing.
    const again = await harness(r.roundId, { apply: 'real', fresh: true });
    await again.start();
    expect(await again.alarm()).toMatchObject({ phase: 'failed', error: 'mode is voided' });
    expect(await ledgerOf(r.roundId)).toEqual(voided);
    expect(await modeStatus(r.roundId)).toBe('voided');
  });
});
