// applyFree's order (W6-F1 R6): the credits and their integrity checks run before the reveal, so a
// result whose credits can't be written throws with the round still unrevealed and nothing paid.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyFree } from '../../src/settlement/apply/free.js';
import { IntegrityError } from '../../src/settlement/prepare.js';
import { atBeaconPlus, harness, recordedDeps, seedPicks } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

async function count(sql: string, roundId: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(roundId).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('applyFree: credits before the reveal', () => {
  it('a payout with no entry throws before revealed_at is set, with no payouts or ledger rows', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([0, 1, 1]);
    // The record hook writes no D1: the mode stays `revealing` with the TallyResult in hand.
    const h = await harness(r.roundId);
    expect(await h.run()).toMatchObject({ phase: 'done' });
    const result = h.applied[0];
    if (!result) throw new Error('no result');
    const [first, ...rest] = result.payouts;
    if (!first) throw new Error('no payouts');
    // A credit bug: the first payout names an account no entry has.
    const forged = {
      ...result,
      payouts: [{ ...first, account: `0x${'cd'.repeat(32)}` }, ...rest],
    };

    const deps = recordedDeps();
    await expect(applyFree(env, forged, deps.deps)).rejects.toBeInstanceOf(IntegrityError);
    const mode = await env.DB.prepare(
      "SELECT status, revealed_at FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(r.roundId)
      .first<{ status: string; revealed_at: number | null }>();
    expect(mode).toEqual({ status: 'revealing', revealed_at: null });
    expect(await count('SELECT COUNT(*) AS n FROM payouts WHERE round_id = ?1', r.roundId)).toBe(0);
    expect(
      await count('SELECT COUNT(*) AS n FROM points_ledger WHERE ref_id = ?1', r.roundId),
    ).toBe(0);
    expect(deps.results).toEqual([]);

    // The real result still applies afterwards (the record is the same bundle's).
    await applyFree(env, result, deps.deps);
    const after = await env.DB.prepare(
      "SELECT status, revealed_at FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(r.roundId)
      .first<{ status: string; revealed_at: number | null }>();
    expect(after?.status).toBe('settled');
    expect(after?.revealed_at).not.toBeNull();
  });
});
