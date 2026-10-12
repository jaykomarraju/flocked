// The daily Stakes cap (spec "Compliance and responsible play" › Responsible play; "Identity and
// personhood" › Entry tickets): a ticket is issued only if the round's stake fits in what is left of
// the user's cap for the round's game day, counting indexed stakes and live tickets.
//
// Everything is counted by the round's game day (the New York date of its closesAt), never by when
// the ticket was issued, so a ticket issued at 20:59 for a round closing at 21:00 counts against
// that round's day, and the next daily round (closing tomorrow) starts a fresh day. Each round
// counts once: an entry and a ticket for the same round are one stake (the contract allows one
// entry per person per round).
import { addGameDays, dailyClosesAt, gameDayOf } from '@flocked/shared';

/** The cap when the user has set none: 100 USDC per game day (USDC base units). */
export const DEFAULT_DAILY_STAKE_CAP = 100_000_000n;

/** Tickets expire this long after issue (spec: 5 minutes). */
export const TICKET_TTL_SEC = 300;

/**
 * A ticket is live (it blocks another for the same person and game day, and holds its stake against
 * the cap) until this long after its expiry (spec: a new ticket only after expiry plus 30 seconds).
 */
export const TICKET_REISSUE_GRACE_SEC = 30;

interface LimitsCapRow {
  daily_stake_cap: number | null;
  pending_cap: number | null;
  pending_cap_effective_at: number | null;
}

/** The cap in force at `t`: a raised cap once its 24 hours have passed, else the set cap or the default. */
export function effectiveDailyCap(row: LimitsCapRow | null, t: number): bigint {
  if (
    row?.pending_cap != null &&
    row.pending_cap_effective_at != null &&
    row.pending_cap_effective_at <= t
  ) {
    return BigInt(row.pending_cap);
  }
  return row?.daily_stake_cap != null ? BigInt(row.daily_stake_cap) : DEFAULT_DAILY_STAKE_CAP;
}

/**
 * What `userId` already has staked on `gameDay` outside `roundId`: one stake per round that has an
 * indexed Stakes entry from the user, a used ticket, or a live one.
 */
export async function stakedOnGameDay(
  db: D1Database,
  userId: string,
  gameDay: string,
  roundId: string,
  nowSec: number,
): Promise<bigint> {
  // Every round of that New York date closes strictly between the neighbouring days' 21:00 closes.
  const lo = dailyClosesAt(addGameDays(gameDay, -1)) * 1000;
  const hi = dailyClosesAt(addGameDays(gameDay, 1)) * 1000;
  const { results } = await db
    .prepare(
      "SELECT r.closes_at, json_extract(r.config_json, '$.stakes.stake') AS stake FROM rounds r " +
        'WHERE r.id <> ?2 AND r.closes_at > ?3 AND r.closes_at < ?4 AND r.id IN (' +
        "SELECT round_id FROM entries WHERE user_id = ?1 AND mode = 'stakes' " +
        'UNION SELECT round_id FROM stakes_tickets WHERE user_id = ?1 AND game_day = ?5 ' +
        'AND (used_tx IS NOT NULL OR expiry + ?7 > ?6))',
    )
    .bind(userId, roundId, lo, hi, gameDay, nowSec, TICKET_REISSUE_GRACE_SEC)
    .all<{ closes_at: number; stake: string | number | null }>();
  return results
    .filter((r) => gameDayOf(Math.floor(r.closes_at / 1000)) === gameDay)
    .reduce((sum, r) => sum + BigInt(r.stake ?? 0), 0n);
}
