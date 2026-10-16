// The daily Stakes cap (spec "Compliance and responsible play" › Responsible play; "Identity and
// personhood" › Entry tickets): a ticket is issued only if the round's stake fits in what is left of
// the user's cap for the round's game day, counting indexed stakes and live tickets.
//
// Everything is counted by the round's game day (the New York date of its closesAt), never by when
// the ticket was issued, so a ticket issued at 20:59 for a round closing at 21:00 counts against
// that round's day, and the next daily round (closing tomorrow) starts a fresh day. Each round
// counts once: an entry and a ticket for the same round are one stake (the contract allows one
// entry per person per round).
//
// An unused ticket counts while it is live (until expiry + 30 s) and, after that, until the indexer
// has processed past its expiry (O2, Oct 12; spec "Identity and personhood" › Entry tickets): an
// entry made with it at the last second may be onchain but not yet indexed, and the ticket is marked
// used only when the `Entered` handler runs. "Processed" is by the block timestamp of the indexer's
// position (owner decision C4, Oct 12; W7-F1 R18): see indexedThroughSec.
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
 * The time (Unix seconds) through which the indexer has processed the escrow's logs, or null when
 * that isn't known yet (no position):
 *   - its stored position is stamped `indexer_state.last_block_timestamp`, the block timestamp of
 *     `last_block_number` (W7-F1 R18). A position stored before migration 0020 has none until the
 *     indexer next advances; for it, the lower bound W6-F1 O2 used: the newest mirrored escrow event
 *     at or below the position plus one second per block after it (block times rise by at least a
 *     second per block), null with no such event;
 *   - and every mirrored event before the oldest one not yet handed to its handlers is handled
 *     (dispatch runs in chain order), so it is processed only to one second before that event's
 *     block: an `Entered` there has not marked its ticket used yet.
 */
export async function indexedThroughSec(
  db: D1Database,
  chainId: number,
  escrow: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT
         s.last_block_timestamp AS block_sec,
         (SELECT e.block_timestamp + (s.last_block_number - e.block_number) FROM chain_events e
          WHERE e.chain_id = s.chain_id AND e.contract = s.contract AND e.removed = 0
            AND e.block_number <= s.last_block_number
          ORDER BY e.block_number DESC LIMIT 1) AS position_sec,
         (SELECT MIN(p.block_timestamp) FROM chain_events p
          WHERE p.chain_id = s.chain_id AND p.dispatched_revision IS NOT p.revision) AS pending_sec
       FROM indexer_state s WHERE s.chain_id = ?1 AND s.contract = ?2`,
    )
    .bind(chainId, escrow.toLowerCase())
    .first<{ block_sec: number | null; position_sec: number | null; pending_sec: number | null }>();
  const through = row?.block_sec ?? row?.position_sec ?? null;
  if (through === null) return null;
  return row?.pending_sec == null ? through : Math.min(through, row.pending_sec - 1);
}

/**
 * What `userId` already has staked on `gameDay` outside `roundId`: one stake per round that has an
 * indexed Stakes entry from the user, a used ticket, a live one, or an unused one the indexer has
 * not processed past (`throughSec`, from indexedThroughSec; null counts every unused ticket).
 */
export async function stakedOnGameDay(
  db: D1Database,
  userId: string,
  gameDay: string,
  roundId: string,
  nowSec: number,
  throughSec: number | null,
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
        'AND (used_tx IS NOT NULL OR expiry + ?7 > ?6 OR ?8 IS NULL OR expiry >= ?8))',
    )
    .bind(userId, roundId, lo, hi, gameDay, nowSec, TICKET_REISSUE_GRACE_SEC, throughSec)
    .all<{ closes_at: number; stake: string | number | null }>();
  return results
    .filter((r) => gameDayOf(Math.floor(r.closes_at / 1000)) === gameDay)
    .reduce((sum, r) => sum + BigInt(r.stake ?? 0), 0n);
}
