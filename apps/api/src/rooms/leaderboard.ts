// The room leaderboard (spec "Profiles, leaderboards and rooms" › Rooms: "a room leaderboard (room
// points, wins this week, streaks)"). Room rounds never count toward global stats or boards, so this
// is computed from the room's own rounds, not from `user_stats`.
//
//   * Ranked by room-points balance, highest first; equal balances share a rank (1, 1, 3); then by
//     join time (oldest first) and user ID for a stable order.
//   * Deleted and merged accounts are left out (spec "Identity and personhood": deleted accounts are
//     excluded from boards and streaks); they stay in the member list.
//   * `winsThisWeek`: settled Free room rounds of this room the member won (a valid entry on the
//     winning option), whose game day (New York date of closesAt) is in the ISO week of the current
//     game day.
//   * `streak`: this room's final Free rounds, newest first by closesAt: settled and won → +1;
//     settled and lost, VOID or not entered → stop; refunded and voided rounds are skipped.
//
// Only the latest `ROOM_STREAK_WINDOW` final rounds are read (a room has at most one round per game
// day, so that is about four months; a longer streak is shown as the window's length). A settled
// mode is read only once its `revealed_at` is set: a member's win says which side won (reveal gating).
import {
  gameDayOf,
  isoWeekOf,
  openGameDayAt,
  type ModeStatus,
  type RoomLeaderboardRow,
} from '@flocked/shared';
import { LISTED_STATUSES, publicMember, type UserColumns } from './rows.js';

/** Final room rounds read for streaks (and this week's wins). */
export const ROOM_STREAK_WINDOW = 120;

/** A member with their room balance (src/rooms/detail.ts reads them). */
export interface MemberRow extends UserColumns {
  role: 'owner' | 'member';
  joined_at: number;
  balance: number;
}

interface FinalRoundRow {
  id: string;
  closes_at: number;
  status: Extract<ModeStatus, 'settled' | 'refunded' | 'voided'>;
  winner: number | null;
}

interface EntryRow {
  round_id: string;
  user_id: string;
  valid: number | null;
  option_index: number | null;
}

async function finalRounds(db: D1Database, roomId: string): Promise<FinalRoundRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.closes_at, m.status, json_extract(s.winners_json, '$.winner') AS winner
       FROM rounds r
       JOIN round_modes m ON m.round_id = r.id AND m.mode = 'free'
         AND m.status IN ('settled', 'refunded', 'voided')
       LEFT JOIN settlements s ON s.round_id = r.id AND s.mode = 'free' AND s.superseded_at IS NULL
       WHERE r.kind = 'room' AND r.room_id = ?1
         AND (m.status <> 'settled' OR m.revealed_at IS NOT NULL)
       ORDER BY r.closes_at DESC, r.id DESC LIMIT ?2`,
    )
    .bind(roomId, ROOM_STREAK_WINDOW)
    .all<FinalRoundRow>();
  return results;
}

/** The winning entries of the settled rounds, as `round:user` keys. */
async function winningEntries(db: D1Database, rounds: FinalRoundRow[]): Promise<Set<string>> {
  const settled = rounds.filter((r) => r.status === 'settled' && r.winner !== null);
  if (settled.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT round_id, user_id, valid, option_index FROM entries
       WHERE mode = 'free' AND user_id IS NOT NULL AND valid = 1
         AND round_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(settled.map((r) => r.id)))
    .all<EntryRow>();
  const winner = new Map(settled.map((r) => [r.id, r.winner]));
  const wins = new Set<string>();
  for (const e of results) {
    if (e.option_index !== null && e.option_index === winner.get(e.round_id)) {
      wins.add(`${e.round_id}:${e.user_id}`);
    }
  }
  return wins;
}

/** Wins this week and the current streak of one member over `rounds` (newest first). */
function scoreOf(
  userId: string,
  rounds: FinalRoundRow[],
  wins: Set<string>,
  week: string,
): { winsThisWeek: number; streak: number } {
  let winsThisWeek = 0;
  let streak = 0;
  let streakOpen = true;
  for (const r of rounds) {
    if (r.status !== 'settled') continue; // refunded or voided: neutral
    const won = wins.has(`${r.id}:${userId}`);
    if (won && isoWeekOf(gameDayOf(Math.floor(r.closes_at / 1000))) === week) winsThisWeek += 1;
    if (streakOpen) {
      if (won) streak += 1;
      else streakOpen = false;
    }
  }
  return { winsThisWeek, streak };
}

/** Competition rank by balance over rows already sorted by balance descending. */
function ranked<T extends { balance: number }>(rows: T[]): (T & { rank: number })[] {
  let rank = 0;
  let prev: number | null = null;
  return rows.map((r, i) => {
    if (r.balance !== prev) rank = i + 1;
    prev = r.balance;
    return { ...r, rank };
  });
}

export async function roomLeaderboard(
  db: D1Database,
  roomId: string,
  members: MemberRow[],
  t: number,
): Promise<RoomLeaderboardRow[]> {
  const listed = members.filter((m) => m.u_status !== null && LISTED_STATUSES.has(m.u_status));
  if (listed.length === 0) return [];
  const rounds = await finalRounds(db, roomId);
  const wins = await winningEntries(db, rounds);
  const week = isoWeekOf(openGameDayAt(Math.floor(t / 1000)));
  const order = [...listed].sort(
    (a, b) =>
      b.balance - a.balance ||
      a.joined_at - b.joined_at ||
      (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0),
  );
  return ranked(order).map((m) => ({
    rank: m.rank,
    user: publicMember(m),
    balance: String(m.balance),
    ...scoreOf(m.user_id, rounds, wins, week),
  }));
}
