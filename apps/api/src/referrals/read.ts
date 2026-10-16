// GET /me/referrals (spec "API"; "Share cards and distribution" › Referral): the caller's invite
// code, the people who signed up with it (newest first) and the referral points the caller has
// earned, as inviter and as invitee. An invitee whose account is deleted or merged has no handle.
import type { ReferralsResponse } from '@flocked/shared';
import type { Env } from '../env.js';
import { GLOBAL_SCOPE } from '../points/index.js';

/** Invitees listed. */
export const REFERRALS_LIMIT = 200;

interface Row {
  status: 'pending' | 'qualified' | 'rewarded';
  handle: string | null;
  qualified_round_id: string | null;
  created_at: number;
  rewarded_at: number | null;
}

export async function readReferrals(
  env: Pick<Env, 'DB'>,
  userId: string,
  refCode: string,
): Promise<ReferralsResponse> {
  const [list, total] = await Promise.all([
    env.DB.prepare(
      `SELECT r.status, CASE WHEN u.status IN ('active', 'suspended') THEN u.handle END AS handle,
              r.qualified_round_id, r.created_at, r.rewarded_at
       FROM referrals r LEFT JOIN users u ON u.id = r.referee_user_id
       WHERE r.referrer_user_id = ?1 ORDER BY r.created_at DESC, r.referee_user_id LIMIT ?2`,
    )
      .bind(userId, REFERRALS_LIMIT)
      .all<Row>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS total FROM points_ledger
       WHERE user_id = ?1 AND scope = ?2 AND reason = 'referral'`,
    )
      .bind(userId, GLOBAL_SCOPE)
      .first<{ total: number }>(),
  ]);
  return {
    refCode,
    referrals: list.results.map((r) => ({
      status: r.status,
      refereeHandle: r.handle,
      qualifiedRoundId: r.qualified_round_id,
      createdAt: r.created_at,
      rewardedAt: r.rewarded_at,
    })),
    rewardTotal: String(total?.total ?? 0),
  };
}
