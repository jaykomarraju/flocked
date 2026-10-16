// user_stats from final daily-round outcomes (spec "Profiles, leaderboards and rooms" › Game day and
// streaks; "Data model" › user_stats: daily rounds only, Stakes results count once final).
//
// The unit is a game day of one mode: the locked daily round's mode once it is final. Days are
// applied strictly in game-day order per mode (`stats_days`, migrations/0018_stats.sql): a mode that
// becomes final late (a Stakes hold, a Free rule-8 refund) holds the later days back, and they are
// applied once it is final. A game day with no daily round, or whose round has no row for the mode,
// is not in the sequence at all, so it is neutral for both streaks.
//
// One day, for every user with a `user_stats` row or an entry:
//   * settled: a valid entry on the winning side is a win (stray streak + 1, the best follows it),
//     a valid entry on the other side a loss, and an invalid entry a refund that still ends the
//     stray streak; a user with no entry loses both streaks;
//   * refunded or voided: neutral for the stray streak, entered or not; an entry still counts as
//     played (refunds + 1, play streak + 1), and a user with no entry loses the play streak.
// `net` moves by payouts minus stake on settled days (points for Free, USDC base units for Stakes)
// and not at all on refunded or voided days, whose stakes come back in full.
//
// Entrants are applied in user-ID chunks. Each chunk's batch upserts `user_stats` (the stray streak
// and its best change in one UPDATE: the CHECK best_stray_streak >= stray_streak), records the
// winners' streaks for the Strays board (`stats_wins`) and the week's wins and net (`stats_weeks`),
// and moves the day's cursor, all conditional on the cursor it read. The last batch resets the
// non-entrants and marks the day done. A retry or a concurrent caller therefore applies every chunk
// exactly once.
//
// A Stakes call runs inside an IndexerDO poll (the Stakes final's hook), under the poll's Workers
// budget (W4-F1 POLL_BUDGET), so it applies at most STATS_SIZES.stakesBatches batches (W8-F1 L5);
// what is left waits for the next call: the next Stakes final's, or the scheduler tick's
// (`drainStakesStats`), which runs every minute, so a backlog always drains.
import { gameDayOf, isoWeekOf, type Mode } from '@flocked/shared';
import type { Env } from '../env.js';
import { raiseAlert } from '../lib/alert.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';
import type { ModeFinalEvent } from '../settlement/hooks.js';

/**
 * Entrants per batch, days per call (a long backlog continues on the next call), and batches per
 * Stakes call (about 6 D1 statements each).
 */
export const STATS_SIZES = { chunk: 1000, days: 7, stakesBatches: 8 };

type Outcome = 'settled' | 'refunded' | 'voided';
const FINAL: ReadonlySet<string> = new Set<Outcome>(['settled', 'refunded', 'voided']);

interface DayRow {
  round_id: string;
  closes_at: number;
  game_day: string;
  outcome: Outcome;
  winner: 0 | 1 | null;
  after_user: string;
}

const IN_PROGRESS =
  'SELECT round_id, closes_at, game_day, outcome, winner, after_user FROM stats_days ' +
  'WHERE mode = ?1 AND done_at IS NULL';

// The first locked daily round of the mode after the last applied one, with its outcome.
const NEXT_DAY = `
  SELECT r.id, r.closes_at, m.status, json_extract(s.winners_json, '$.winner') AS winner
  FROM rounds r JOIN round_modes m ON m.round_id = r.id AND m.mode = ?1
  LEFT JOIN settlements s ON s.round_id = r.id AND s.mode = ?1 AND s.superseded_at IS NULL
  WHERE r.kind = 'daily' AND r.locked_at IS NOT NULL
    AND r.closes_at > COALESCE((SELECT MAX(closes_at) FROM stats_days WHERE mode = ?1), -1)
  ORDER BY r.closes_at LIMIT 1`;

// Starts a day unless one is in progress or a later day is already applied (a concurrent caller).
const START_DAY = `
  INSERT INTO stats_days (round_id, mode, closes_at, game_day, outcome, winner, started_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
  WHERE NOT EXISTS (SELECT 1 FROM stats_days WHERE mode = ?2 AND (done_at IS NULL OR closes_at >= ?3))
  ON CONFLICT DO NOTHING`;

// The day is still where this caller read it.
const DAY_AT = `EXISTS (SELECT 1 FROM stats_days d WHERE d.round_id = ?1 AND d.mode = ?2
  AND d.done_at IS NULL AND d.after_user = ?3)`;

// ?1 round, ?2 mode, ?3 after, ?4 through (user IDs), ?5 outcome, ?6 winner.
const ENTRANTS = `
  SELECT e.user_id, e.created_at,
    CASE WHEN ?5 = 'settled' AND e.valid = 1 AND e.option_index = ?6 THEN 1 ELSE 0 END AS win,
    CASE WHEN ?5 = 'settled' AND e.valid = 1 AND e.option_index <> ?6 THEN 1 ELSE 0 END AS loss,
    CASE WHEN ?5 <> 'settled' OR e.valid IS NOT 1 THEN 1 ELSE 0 END AS refund,
    CASE WHEN ?5 = 'settled' THEN COALESCE((SELECT SUM(p.amount) FROM payouts p
      WHERE p.round_id = e.round_id AND p.mode = e.mode AND p.user_id = e.user_id), 0) - e.stake
      ELSE 0 END AS net
  FROM entries e
  WHERE e.round_id = ?1 AND e.mode = ?2 AND e.user_id IS NOT NULL AND e.foreign_entry = 0
    AND e.user_id > ?3 AND e.user_id <= ?4`;

// ?7 time. Old values on the right of SET: the best follows the streak in the same UPDATE.
const UPSERT_STATS = `
  INSERT INTO user_stats (user_id, mode, rounds_played, wins, losses, refunds, stray_streak,
    best_stray_streak, play_streak, net, updated_at)
  SELECT x.user_id, ?2, 1, x.win, x.loss, x.refund, x.win, x.win, 1, x.net, ?7
  FROM (${ENTRANTS}) x WHERE ${DAY_AT}
  ON CONFLICT (user_id, mode) DO UPDATE SET
    rounds_played = rounds_played + 1,
    wins = wins + excluded.wins,
    losses = losses + excluded.losses,
    refunds = refunds + excluded.refunds,
    stray_streak = CASE WHEN ?5 <> 'settled' THEN stray_streak
                        WHEN excluded.wins = 1 THEN stray_streak + 1 ELSE 0 END,
    best_stray_streak = CASE WHEN excluded.wins = 1 AND stray_streak + 1 > best_stray_streak
                             THEN stray_streak + 1 ELSE best_stray_streak END,
    play_streak = play_streak + 1,
    net = net + excluded.net,
    updated_at = excluded.updated_at`;

// After UPSERT_STATS in the same batch: the streaks the winners reached today.
const INSERT_WINS = `
  INSERT INTO stats_wins (round_id, mode, user_id, stray_streak, best_stray_streak, entered_at)
  SELECT ?1, ?2, x.user_id, s.stray_streak, s.best_stray_streak, x.created_at
  FROM (${ENTRANTS}) x JOIN user_stats s ON s.user_id = x.user_id AND s.mode = ?2
  WHERE x.win = 1 AND ${DAY_AT}
  ON CONFLICT DO NOTHING`;

// ?8 ISO week. Settled days only: a refunded or voided day adds no win and no net.
const UPSERT_WEEK = `
  INSERT INTO stats_weeks (user_id, mode, iso_week, wins, net, updated_at)
  SELECT x.user_id, ?2, ?8, x.win, x.net, ?7
  FROM (${ENTRANTS}) x WHERE ?5 = 'settled' AND ${DAY_AT}
  ON CONFLICT (user_id, mode, iso_week) DO UPDATE SET
    wins = wins + excluded.wins, net = net + excluded.net, updated_at = excluded.updated_at`;

const ADVANCE = `UPDATE stats_days SET after_user = ?4
  WHERE round_id = ?1 AND mode = ?2 AND done_at IS NULL AND after_user = ?3`;

// ?1 round, ?2 mode, ?3 after, ?4 outcome, ?5 time. Users with no counted entry that day.
const RESET_ABSENT = `
  UPDATE user_stats SET
    stray_streak = CASE WHEN ?4 = 'settled' THEN 0 ELSE stray_streak END,
    play_streak = 0,
    updated_at = ?5
  WHERE mode = ?2 AND (play_streak > 0 OR (?4 = 'settled' AND stray_streak > 0))
    AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.round_id = ?1 AND e.mode = ?2
                    AND e.user_id = user_stats.user_id AND e.foreign_entry = 0)
    AND ${DAY_AT}`;

const FINISH = `UPDATE stats_days SET done_at = ?4
  WHERE round_id = ?1 AND mode = ?2 AND done_at IS NULL AND after_user = ?3`;

/** The last entrant ID of the next chunk after `after`, or null when none is left. */
async function chunkEnd(db: D1Database, day: DayRow, mode: Mode): Promise<string | null> {
  const base =
    'FROM entries WHERE round_id = ?1 AND mode = ?2 AND user_id IS NOT NULL AND foreign_entry = 0 AND user_id > ?3';
  const at = await db
    .prepare(`SELECT user_id ${base} ORDER BY user_id LIMIT 1 OFFSET ?4`)
    .bind(day.round_id, mode, day.after_user, STATS_SIZES.chunk - 1)
    .first<{ user_id: string }>();
  if (at) return at.user_id;
  const last = await db
    .prepare(`SELECT MAX(user_id) AS user_id ${base}`)
    .bind(day.round_id, mode, day.after_user)
    .first<{ user_id: string | null }>();
  return last?.user_id ?? null;
}

/** Applies one batch of `day` (a chunk, or the closing batch). Returns false once it is done. */
async function step(db: D1Database, mode: Mode, day: DayRow, t: number): Promise<boolean> {
  const through = await chunkEnd(db, day, mode);
  if (through === null) {
    await db.batch([
      db.prepare(RESET_ABSENT).bind(day.round_id, mode, day.after_user, day.outcome, t),
      db.prepare(FINISH).bind(day.round_id, mode, day.after_user, t),
    ]);
    return false;
  }
  const week = isoWeekOf(day.game_day);
  const args = [day.round_id, mode, day.after_user, through, day.outcome, day.winner, t];
  await db.batch([
    db.prepare(UPSERT_STATS).bind(...args),
    db.prepare(INSERT_WINS).bind(...args.slice(0, 6)),
    db.prepare(UPSERT_WEEK).bind(...args, week),
    db.prepare(ADVANCE).bind(day.round_id, mode, day.after_user, through),
  ]);
  return true;
}

/** Called when a final day can't be applied (its data is inconsistent): stats stop there. */
export type StatsBlocked = (data: { mode: Mode; roundId: string; reason: string }) => void;

/** Starts the next day if it is final. Returns false when there is nothing to start. */
async function startNext(
  db: D1Database,
  mode: Mode,
  t: number,
  blocked: StatsBlocked,
): Promise<boolean> {
  const next = await db
    .prepare(NEXT_DAY)
    .bind(mode)
    .first<{ id: string; closes_at: number; status: string; winner: number | null }>();
  if (!next) return false;
  if (!FINAL.has(next.status)) {
    log.info('stats_waiting', { mode, roundId: next.id, status: next.status });
    return false;
  }
  const outcome = next.status as Outcome;
  const winner = outcome === 'settled' ? next.winner : null;
  if (outcome === 'settled' && winner !== 0 && winner !== 1) {
    // A settled mode always has its current settlement with a winner. Without one, stop here and
    // alert rather than throw: a throw would fail every later settlement's hooks, not just stats.
    blocked({ mode, roundId: next.id, reason: 'settled_without_winner' });
    return false;
  }
  const gameDay = gameDayOf(Math.floor(next.closes_at / 1000));
  await db
    .prepare(START_DAY)
    .bind(next.id, mode, next.closes_at, gameDay, outcome, winner, t)
    .run();
  return true;
}

/**
 * Applies every final day of `mode` that is next in line, up to `STATS_SIZES.days` of them, and for
 * Stakes up to `STATS_SIZES.stakesBatches` batches. Idempotent and safe to run concurrently; it
 * returns the number of days it finished.
 */
export async function applyFinalDays(
  db: D1Database,
  mode: Mode,
  t: number,
  blocked: StatsBlocked = (data) => log.error('stats_blocked', data),
): Promise<number> {
  const maxBatches = mode === 'stakes' ? STATS_SIZES.stakesBatches : Infinity;
  let finished = 0;
  let batches = 0;
  while (finished < STATS_SIZES.days && batches < maxBatches) {
    const day = await db.prepare(IN_PROGRESS).bind(mode).first<DayRow>();
    if (!day) {
      if (!(await startNext(db, mode, t, blocked))) break;
      continue; // read it back: a concurrent caller may have started it instead
    }
    batches += 1;
    if (!(await step(db, mode, day, t))) {
      finished += 1;
      log.info('stats_day_applied', { mode, roundId: day.round_id, outcome: day.outcome });
    }
  }
  return finished;
}

/**
 * The scheduler tick's share (W8-F1 L5): the Stakes days a bounded hook call left, one bounded call
 * a minute. A blocked day is logged here; the hook alerts.
 */
export async function drainStakesStats(env: Env, t: number): Promise<number> {
  return applyFinalDays(env.DB, 'stakes', t);
}

/** The `onModeFinal` handler: daily rounds only (room rounds never touch global stats). */
export async function statsOnModeFinal(env: Env, event: ModeFinalEvent): Promise<void> {
  if (event.kind !== 'daily') return;
  await applyFinalDays(env.DB, event.mode, now(env), (data) => {
    log.error('stats_blocked', data);
    raiseAlert(env, 'ALERT_DO_ERROR', { step: 'stats_blocked', ...data });
  });
}
