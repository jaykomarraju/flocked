// Leaderboards (spec "Profiles, leaderboards and rooms" › Leaderboards; GET /leaderboards/:board).
//
// | Board    | Ranking                                   | Period   | Tie-break                     |
// | strays   | the day's winners, by their stray streak  | game day | best stray streak, then entry |
// | streaks  | best stray streak, current one shown      | all time | current streak, rounds played |
// | weekly   | wins in the ISO week of the game day      | ISO week | net result                    |
// | creators | mean split quality of used questions (≥2) | all time | number of used questions      |
//
// Every board has a mode filter and lists only verified users (a person ID with `kyc_status`
// verified) whose account is active: merged, deleted and suspended accounts never appear. Unverified
// users' entries still count in every tally; they just aren't listed. Rows tied on every metric share
// a rank (1, 2, 2, 4); the user ID orders them for a stable page.
//
// The boards read what src/stats/apply.ts wrote from final outcomes (`user_stats`, `stats_wins`,
// `stats_weeks`), except creators, which reads the revealed tallies of final daily modes.
import {
  isoWeekOf,
  type Board,
  type LeaderboardResponse,
  type LeaderboardRow,
  type Mode,
  type PublicUser,
} from '@flocked/shared';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { splitQualitySql } from './split.js';

/** Rows per board. */
export const BOARD_LIMIT = 100;

/** Listed users (alias `u`). */
export const LISTED =
  "u.status = 'active' AND u.person_id IS NOT NULL AND u.kyc_status = 'verified'";

const GAME_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WEEK = /^\d{4}-W\d{2}$/;

interface UserCols {
  user_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

const USER_COLS = 'u.id AS user_id, u.handle, u.display_name, u.avatar_url';

function publicUser(r: UserCols): PublicUser {
  return { id: r.user_id, handle: r.handle, displayName: r.display_name, avatarUrl: r.avatar_url };
}

/** Competition ranks over rows already in board order: equal keys share the earlier rank. */
function ranked<T>(rows: T[], key: (r: T) => string, row: (r: T, rank: number) => LeaderboardRow) {
  let rank = 0;
  let prev: string | null = null;
  return rows.map((r, i) => {
    const k = key(r);
    if (k !== prev) rank = i + 1;
    prev = k;
    return row(r, rank);
  });
}

async function all<T>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {
  return (
    await db
      .prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}

/** The latest applied day of `mode` (any outcome), or null before the first. */
async function latestDay(
  db: D1Database,
  mode: Mode,
): Promise<{ round_id: string; game_day: string; outcome: string } | null> {
  return db
    .prepare(
      `SELECT round_id, game_day, outcome FROM stats_days WHERE mode = ?1 AND done_at IS NOT NULL
       ORDER BY closes_at DESC LIMIT 1`,
    )
    .bind(mode)
    .first();
}

interface Query {
  mode: Mode;
  period?: string;
  /** The signed-in caller, for `me`. */
  viewerId?: string;
}

// strays ----------------------------------------------------------------------------------------

interface StrayRow extends UserCols {
  stray_streak: number;
  best_stray_streak: number;
  entered_at: number;
}

async function strays(db: D1Database, q: Query): Promise<LeaderboardResponse> {
  if (q.period !== undefined && !GAME_DAY.test(q.period)) {
    throw new HttpError('bad_request', 'The strays board takes a game day (YYYY-MM-DD)');
  }
  const day = q.period
    ? await db
        .prepare(
          'SELECT round_id, game_day FROM stats_days WHERE mode = ?1 AND game_day = ?2 AND done_at IS NOT NULL',
        )
        .bind(q.mode, q.period)
        .first<{ round_id: string; game_day: string }>()
    : await latestDay(db, q.mode);
  const period = day?.game_day ?? q.period ?? null;
  if (!day) return { board: 'strays', mode: q.mode, period, rows: [], me: null };

  const select = `SELECT ${USER_COLS}, w.stray_streak, w.best_stray_streak, w.entered_at
    FROM stats_wins w JOIN users u ON u.id = w.user_id
    WHERE w.round_id = ?1 AND w.mode = ?2 AND ${LISTED}`;
  const toRow = (r: StrayRow, rank: number): LeaderboardRow => ({
    rank,
    user: publicUser(r),
    strayStreak: r.stray_streak,
    bestStrayStreak: r.best_stray_streak,
    enteredAt: r.entered_at,
  });
  const key = (r: StrayRow) => `${r.stray_streak}:${r.best_stray_streak}:${r.entered_at}`;
  const rows = await all<StrayRow>(
    db,
    `${select} ORDER BY w.stray_streak DESC, w.best_stray_streak DESC, w.entered_at, u.id LIMIT ?3`,
    day.round_id,
    q.mode,
    BOARD_LIMIT,
  );
  let me: LeaderboardRow | null = null;
  const mine = q.viewerId
    ? await db
        .prepare(`${select} AND w.user_id = ?3`)
        .bind(day.round_id, q.mode, q.viewerId)
        .first<StrayRow>()
    : null;
  if (mine) {
    const ahead = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM stats_wins w JOIN users u ON u.id = w.user_id
         WHERE w.round_id = ?1 AND w.mode = ?2 AND ${LISTED}
           AND (w.stray_streak > ?3 OR (w.stray_streak = ?3 AND (w.best_stray_streak > ?4
             OR (w.best_stray_streak = ?4 AND w.entered_at < ?5))))`,
      )
      .bind(day.round_id, q.mode, mine.stray_streak, mine.best_stray_streak, mine.entered_at)
      .first<{ n: number }>();
    me = toRow(mine, (ahead?.n ?? 0) + 1);
  }
  return { board: 'strays', mode: q.mode, period, rows: ranked(rows, key, toRow), me };
}

// streaks ---------------------------------------------------------------------------------------

interface StreakRow extends UserCols {
  stray_streak: number;
  best_stray_streak: number;
  rounds_played: number;
}

async function streaks(db: D1Database, q: Query): Promise<LeaderboardResponse> {
  const select = `SELECT ${USER_COLS}, s.stray_streak, s.best_stray_streak, s.rounds_played
    FROM user_stats s JOIN users u ON u.id = s.user_id
    WHERE s.mode = ?1 AND s.best_stray_streak > 0 AND ${LISTED}`;
  const toRow = (r: StreakRow, rank: number): LeaderboardRow => ({
    rank,
    user: publicUser(r),
    strayStreak: r.stray_streak,
    bestStrayStreak: r.best_stray_streak,
    roundsPlayed: r.rounds_played,
  });
  const key = (r: StreakRow) => `${r.best_stray_streak}:${r.stray_streak}:${r.rounds_played}`;
  const rows = ranked(
    await all<StreakRow>(
      db,
      `${select} ORDER BY s.best_stray_streak DESC, s.stray_streak DESC, s.rounds_played DESC, u.id
       LIMIT ?2`,
      q.mode,
      BOARD_LIMIT,
    ),
    key,
    toRow,
  );
  // The accent pill: the highest current streak shown, the first by rank on a tie.
  let top: LeaderboardRow | undefined;
  for (const r of rows) {
    if ((r.strayStreak ?? 0) > (top?.strayStreak ?? 0)) top = r;
  }
  if (top) top.topLiveStreak = true;

  let me: LeaderboardRow | null = null;
  const mine = q.viewerId
    ? await db.prepare(`${select} AND s.user_id = ?2`).bind(q.mode, q.viewerId).first<StreakRow>()
    : null;
  if (mine) {
    const ahead = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_stats s JOIN users u ON u.id = s.user_id
         WHERE s.mode = ?1 AND ${LISTED}
           AND (s.best_stray_streak > ?2 OR (s.best_stray_streak = ?2 AND (s.stray_streak > ?3
             OR (s.stray_streak = ?3 AND s.rounds_played > ?4))))`,
      )
      .bind(q.mode, mine.best_stray_streak, mine.stray_streak, mine.rounds_played)
      .first<{ n: number }>();
    me = toRow(mine, (ahead?.n ?? 0) + 1);
  }
  return { board: 'streaks', mode: q.mode, period: null, rows, me };
}

// weekly ----------------------------------------------------------------------------------------

interface WeekRow extends UserCols {
  wins: number;
  net: number;
  prefs_json: string;
}

/** Stakes net is private unless the user shows it (spec Profiles); Free net is public. */
export function showsNet(mode: Mode, prefsJson: string): boolean {
  if (mode === 'free') return true;
  try {
    return (JSON.parse(prefsJson) as { show_stakes_net?: unknown }).show_stakes_net === true;
  } catch {
    return false;
  }
}

async function weekly(db: D1Database, q: Query): Promise<LeaderboardResponse> {
  if (q.period !== undefined && !ISO_WEEK.test(q.period)) {
    throw new HttpError('bad_request', 'The weekly board takes an ISO week (YYYY-Www)');
  }
  let week = q.period ?? null;
  if (week === null) {
    const day = await latestDay(db, q.mode);
    if (day) week = isoWeekOf(day.game_day);
  }
  if (week === null) return { board: 'weekly', mode: q.mode, period: null, rows: [], me: null };

  const select = `SELECT ${USER_COLS}, w.wins, w.net, u.prefs_json
    FROM stats_weeks w JOIN users u ON u.id = w.user_id
    WHERE w.mode = ?1 AND w.iso_week = ?2 AND w.wins > 0 AND ${LISTED}`;
  const toRow =
    (own: boolean) =>
    (r: WeekRow, rank: number): LeaderboardRow => ({
      rank,
      user: publicUser(r),
      wins: r.wins,
      ...(own || showsNet(q.mode, r.prefs_json) ? { net: String(r.net) } : {}),
    });
  const key = (r: WeekRow) => `${r.wins}:${r.net}`;
  const rows = await all<WeekRow>(
    db,
    `${select} ORDER BY w.wins DESC, w.net DESC, u.id LIMIT ?3`,
    q.mode,
    week,
    BOARD_LIMIT,
  );
  let me: LeaderboardRow | null = null;
  const mine = q.viewerId
    ? await db
        .prepare(`${select} AND w.user_id = ?3`)
        .bind(q.mode, week, q.viewerId)
        .first<WeekRow>()
    : null;
  if (mine) {
    const ahead = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM stats_weeks w JOIN users u ON u.id = w.user_id
         WHERE w.mode = ?1 AND w.iso_week = ?2 AND w.wins > 0 AND ${LISTED}
           AND (w.wins > ?3 OR (w.wins = ?3 AND w.net > ?4))`,
      )
      .bind(q.mode, week, mine.wins, mine.net)
      .first<{ n: number }>();
    // The caller's own row always shows their net (the response is private when signed in).
    me = toRow(true)(mine, (ahead?.n ?? 0) + 1);
  }
  return {
    board: 'weekly',
    mode: q.mode,
    period: week,
    rows: ranked(rows, key, toRow(false)),
    me,
  };
}

// creators --------------------------------------------------------------------------------------

interface CreatorRow extends UserCols {
  quality: number;
  used: number;
}

/** Minimum used questions to be ranked (spec Leaderboards). */
export const CREATOR_MIN_QUESTIONS = 2;

async function creators(db: D1Database, q: Query): Promise<LeaderboardResponse> {
  // Every listed author with enough used questions; there is one daily question a day, so this set
  // stays small enough to rank here.
  const all_ = await all<CreatorRow>(
    db,
    `SELECT ${USER_COLS}, AVG(${splitQualitySql('t.h0', 't.h1')}) AS quality, COUNT(*) AS used
     FROM (
       SELECT r.question_id,
              CAST(json_extract(s.tally_json, '$[0].headcount') AS INTEGER) AS h0,
              CAST(json_extract(s.tally_json, '$[1].headcount') AS INTEGER) AS h1
       FROM rounds r
       JOIN round_modes m ON m.round_id = r.id AND m.mode = ?1
         AND m.status IN ('settled', 'refunded') AND m.revealed_at IS NOT NULL
       JOIN settlements s ON s.round_id = r.id AND s.mode = ?1 AND s.superseded_at IS NULL
       WHERE r.kind = 'daily' AND r.locked_at IS NOT NULL
     ) t
     JOIN questions q ON q.id = t.question_id AND q.status = 'used' AND q.author_user_id IS NOT NULL
     JOIN users u ON u.id = q.author_user_id
     WHERE t.h0 + t.h1 > 0 AND ${LISTED}
     GROUP BY u.id HAVING COUNT(*) >= ?2
     ORDER BY quality DESC, used DESC, u.id`,
    q.mode,
    CREATOR_MIN_QUESTIONS,
  );
  const toRow = (r: CreatorRow, rank: number): LeaderboardRow => ({
    rank,
    user: publicUser(r),
    splitQuality: Math.min(1, Math.max(0, r.quality)),
    usedQuestions: r.used,
  });
  const rows = ranked(all_, (r) => `${r.quality}:${r.used}`, toRow);
  const me = q.viewerId ? (rows.find((r) => r.user.id === q.viewerId) ?? null) : null;
  return { board: 'creators', mode: q.mode, period: null, rows: rows.slice(0, BOARD_LIMIT), me };
}

const BOARDS: Record<Board, (db: D1Database, q: Query) => Promise<LeaderboardResponse>> = {
  strays,
  streaks,
  weekly,
  creators,
};

/** GET /leaderboards/:board. */
export function readBoard(
  env: Pick<Env, 'DB'>,
  board: Board,
  q: Query,
): Promise<LeaderboardResponse> {
  return BOARDS[board](env.DB, q);
}
