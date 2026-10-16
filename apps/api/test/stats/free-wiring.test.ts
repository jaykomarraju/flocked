// The Free apply hook end to end: a real SettlementDO settles a daily Free round through the real
// applyFree, whose last step runs the post-final hooks. The stats count the round and a pending
// referral of an entrant qualifies. (Its own file: the day sequence starts at this file's rounds.)
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atBeaconPlus, harness, seedPicks } from '../settlement/helpers.js';
import { statsOf } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyFree → onModeFinal', () => {
  it('a settled daily Free round moves user_stats and qualifies a referral', async () => {
    atBeaconPlus(5_000);
    // One on option 0 (the stray) and two on option 1.
    const r = await seedPicks([0, 1, 1]);
    const [stray, flock] = r.entries;
    if (!stray || !flock) throw new Error('no entries');
    await env.DB.prepare(
      "INSERT INTO referrals (referrer_user_id, referee_user_id, status, created_at) VALUES ('01K8A000000000000000077777', ?1, 'pending', 1)",
    )
      .bind(stray.userId)
      .run();

    const h = await harness(r.roundId, { apply: 'real' });
    expect(await h.run()).toMatchObject({ phase: 'done', error: null });

    expect(await statsOf(stray.userId)).toMatchObject({
      rounds_played: 1,
      wins: 1,
      stray_streak: 1,
      best_stray_streak: 1,
      play_streak: 1,
    });
    expect(await statsOf(flock.userId)).toMatchObject({
      rounds_played: 1,
      losses: 1,
      stray_streak: 0,
    });
    const ref = await env.DB.prepare(
      'SELECT status, qualified_round_id FROM referrals WHERE referee_user_id = ?1',
    )
      .bind(stray.userId)
      .first();
    // Qualified; not rewarded, since neither account exists to pass the farming rule.
    expect(ref).toEqual({ status: 'qualified', qualified_round_id: r.roundId });
  });
});
