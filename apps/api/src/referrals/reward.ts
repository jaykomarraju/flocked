// Referral qualification and reward (spec "Share cards and distribution" › Referral; "Anti-abuse" ›
// Points farming). Attribution is W3-A's: signup with a carried `ref` inserts a `pending` row
// (src/auth/accounts.ts); the client keeps the code for 7 days before signup.
//
//   * Qualification: the invitee's first valid Free entry in a daily round settles. On every
//     settled daily Free mode, the invitee's pending referral becomes `qualified` with that round.
//     Room rounds, Stakes and refunded rounds never qualify.
//   * Reward: both users get 100 global points (`referral`, ref = the invitee's user ID), once
//     each passes the daily grant's farming rule (src/rounds/grant.ts: `recordPriorTransactions`
//     first, then `dailyGrantEligible`), both accounts are active, and the inviter has had fewer
//     than 10 referrals rewarded in the ISO week of the game day. A referral that fails any of these
//     stays `qualified` and is tried again on the next daily Free mode that becomes final (the
//     invitee may be under 24 hours old when it qualifies); attempts rotate by `checked_at`.
//
// The reward is one D1 batch: the `qualified → rewarded` update checks the cap and both statuses
// itself, the two ledger rows are inserted only if that update happened, and the balances move by
// exactly the rows inserted. A retry or a concurrent call cannot pay twice or past the cap.
import { gameDayOf, isoWeekOf, newUlid } from '@flocked/shared';
import type { Transport } from 'viem';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';
import { GLOBAL_SCOPE } from '../points/index.js';
import { dailyGrantEligible, recordPriorTransactions } from '../rounds/grant.js';
import type { ModeFinalEvent } from '../settlement/hooks.js';

/** Spec "Share cards and distribution" › Referral, "Anti-abuse" › Points farming. */
export const REFERRAL = { bonus: 100, weeklyCap: 10, attemptsPerCall: 50 } as const;

/** Test seam: the RPC transport for the wallet-history read. */
export const REFERRAL_DEPS: { transport?: Transport } = {};

/** Marks the pending referrals of the round's valid entrants qualified (settled daily Free only). */
export async function qualifyReferrals(db: D1Database, roundId: string): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE referrals SET status = 'qualified', qualified_round_id = ?1
       WHERE status = 'pending' AND referee_user_id IN (
         SELECT e.user_id FROM entries e
         JOIN rounds r ON r.id = e.round_id AND r.kind = 'daily'
         JOIN round_modes m ON m.round_id = e.round_id AND m.mode = 'free' AND m.status = 'settled'
         WHERE e.round_id = ?1 AND e.mode = 'free' AND e.valid = 1 AND e.user_id IS NOT NULL)`,
    )
    .bind(roundId)
    .run();
  return res.meta.changes;
}

// ?1 invitee, ?2 inviter, ?3 time, ?4 ISO week, ?5 weekly cap.
const CLAIM = `
  UPDATE referrals SET status = 'rewarded', rewarded_at = ?3, reward_week = ?4, checked_at = ?3
  WHERE referee_user_id = ?1 AND referrer_user_id = ?2 AND status = 'qualified'
    AND (SELECT COUNT(*) FROM referrals WHERE referrer_user_id = ?2 AND reward_week = ?4) < ?5
    AND (SELECT COUNT(*) FROM users WHERE id IN (?1, ?2) AND status = 'active') = 2`;
// ?1 invitee, ?2 the credited user, ?3 time, ?4 ledger ID, ?5 amount.
const LEDGER = `
  INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at)
  SELECT ?4, ?2, '${GLOBAL_SCOPE}', ?5, 'referral', ?1, ?3
  WHERE EXISTS (SELECT 1 FROM referrals WHERE referee_user_id = ?1 AND status = 'rewarded'
                AND rewarded_at = ?3)
  ON CONFLICT DO NOTHING`;
const CREDIT = `
  INSERT INTO point_balances (user_id, scope, balance, updated_at)
  SELECT l.user_id, l.scope, l.delta, ?3 FROM points_ledger l WHERE l.id IN (?1, ?2)
  ON CONFLICT (user_id, scope) DO UPDATE SET balance = balance + excluded.balance,
    updated_at = excluded.updated_at`;

interface Waiting {
  referrer_user_id: string;
  referee_user_id: string;
}

/** True when the user passes the farming rule now, after reading their wallets' history. */
async function eligible(env: Env, userId: string, roundId: string, t: number): Promise<boolean> {
  await recordPriorTransactions(env, { userId, roundId, now: t }, REFERRAL_DEPS);
  return dailyGrantEligible(env.DB, { userId, now: t });
}

/**
 * Tries to reward up to `REFERRAL.attemptsPerCall` qualified referrals, least recently tried
 * first. `roundId` is the daily round whose mode just became final (the grant-history key) and
 * `gameDay` its game day (the cap's week). Returns the number rewarded.
 */
export async function rewardQualified(
  env: Env,
  i: { roundId: string; gameDay: string; now: number },
): Promise<number> {
  const db = env.DB;
  const week = isoWeekOf(i.gameDay);
  const { results } = await db
    .prepare(
      `SELECT referrer_user_id, referee_user_id FROM referrals WHERE status = 'qualified'
       ORDER BY checked_at IS NOT NULL, checked_at, created_at LIMIT ?1`,
    )
    .bind(REFERRAL.attemptsPerCall)
    .all<Waiting>();
  let rewarded = 0;
  for (const r of results) {
    const ok =
      (await eligible(env, r.referee_user_id, i.roundId, i.now)) &&
      (await eligible(env, r.referrer_user_id, i.roundId, i.now));
    if (!ok) {
      await db
        .prepare(
          "UPDATE referrals SET checked_at = ?2 WHERE referee_user_id = ?1 AND status = 'qualified'",
        )
        .bind(r.referee_user_id, i.now)
        .run();
      continue;
    }
    const inviterRow = newUlid(i.now);
    const inviteeRow = newUlid(i.now);
    const [claim] = await db.batch([
      db
        .prepare(CLAIM)
        .bind(r.referee_user_id, r.referrer_user_id, i.now, week, REFERRAL.weeklyCap),
      db
        .prepare(LEDGER)
        .bind(r.referee_user_id, r.referrer_user_id, i.now, inviterRow, REFERRAL.bonus),
      db
        .prepare(LEDGER)
        .bind(r.referee_user_id, r.referee_user_id, i.now, inviteeRow, REFERRAL.bonus),
      db.prepare(CREDIT).bind(inviterRow, inviteeRow, i.now),
      // Not rewarded (the cap, or an account no longer active): it waits its turn again.
      db
        .prepare(
          "UPDATE referrals SET checked_at = ?2 WHERE referee_user_id = ?1 AND status = 'qualified'",
        )
        .bind(r.referee_user_id, i.now),
    ]);
    if ((claim?.meta.changes ?? 0) > 0) {
      rewarded += 1;
      log.info('referral_rewarded', { referee: r.referee_user_id, week });
    }
  }
  return rewarded;
}

/** The `onModeFinal` handler: daily Free modes only (room rounds and Stakes never qualify). */
export async function referralsOnModeFinal(env: Env, event: ModeFinalEvent): Promise<void> {
  if (event.kind !== 'daily' || event.mode !== 'free') return;
  if (event.outcome === 'settled') await qualifyReferrals(env.DB, event.roundId);
  const round = await env.DB.prepare('SELECT closes_at FROM rounds WHERE id = ?1')
    .bind(event.roundId)
    .first<{ closes_at: number }>();
  if (!round) throw new Error(`referrals: round ${event.roundId} not found`);
  await rewardQualified(env, {
    roundId: event.roundId,
    gameDay: gameDayOf(Math.floor(round.closes_at / 1000)),
    now: now(env),
  });
}
