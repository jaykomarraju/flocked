// Public profiles (spec "Profiles, leaderboards and rooms" › Profiles; GET /users/:handle): handle,
// avatar, stats per mode (rounds played, wins and losses for the win rate, current and best stray
// streak, play streak), authored questions with split quality, and recent results. The Stakes net
// result is null unless the user opted in (`prefs_json.show_stakes_net`).
//
// Deleted and merged accounts are not found. Suspended accounts are read-only but still exist, so
// their profile stays readable. Only daily rounds count, and only final outcomes (the stats rule):
// a recent result is listed once its mode is settled, refunded or voided.
//
// Authored questions: `queued` ones (public in the vote queue) and `used` ones whose daily round has
// opened (a used question is locked a day ahead and must not leak before its round opens), never a
// room's question (W8-D: private to the room). Split quality comes from the Free mode's revealed
// tally of a settled mode, or the Stakes one without it; a refunded or voided mode has none (W8-F1
// L6, decision of Oct 16, 2026).
import {
  QuestionOptionSchema,
  gameDayOf,
  type EntryResult,
  type Mode,
  type UserModeStats,
  type UserProfileResponse,
} from '@flocked/shared';
import { z } from 'zod';
import { showsNet } from '../boards/read.js';
import { splitQuality } from '../boards/split.js';
import type { Env } from '../env.js';

/** Authored questions and recent results listed. */
export const PROFILE_LIMITS = { questions: 50, recent: 20 } as const;

const OptionsSchema = z.tuple([QuestionOptionSchema, QuestionOptionSchema]);

interface UserRow {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: number;
  prefs_json: string;
}

interface StatsRow {
  mode: Mode;
  rounds_played: number;
  wins: number;
  losses: number;
  refunds: number;
  stray_streak: number;
  best_stray_streak: number;
  play_streak: number;
  net: number;
}

interface QuestionRow {
  id: string;
  prompt: string;
  options_json: string;
  status: 'queued' | 'used';
  round_id: string | null;
}

interface RecentRow {
  round_id: string;
  mode: Mode;
  closes_at: number;
  status: 'settled' | 'refunded' | 'voided';
  revealed_at: number | null;
  valid: number | null;
  option_index: number | null;
  winner: number | null;
}

/** An entry's result, as GET /rounds/:id/me derives it (src/read/me.ts). */
function resultOf(r: RecentRow): EntryResult {
  if (r.revealed_at !== null && r.valid === 0) return 'void';
  if (r.status !== 'settled') return 'refund';
  if (r.valid !== 1) return 'void';
  return r.option_index === r.winner ? 'win' : 'loss';
}

async function splitQualities(
  db: D1Database,
  roundIds: string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (roundIds.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT s.round_id, s.mode,
              CAST(json_extract(s.tally_json, '$[0].headcount') AS INTEGER) AS h0,
              CAST(json_extract(s.tally_json, '$[1].headcount') AS INTEGER) AS h1
       FROM settlements s
       JOIN round_modes m ON m.round_id = s.round_id AND m.mode = s.mode
         AND m.status = 'settled' AND m.revealed_at IS NOT NULL
       WHERE s.superseded_at IS NULL AND s.round_id IN (SELECT value FROM json_each(?1))
       ORDER BY s.mode`, // 'free' before 'stakes'
    )
    .bind(JSON.stringify(roundIds))
    .all<{ round_id: string; mode: Mode; h0: number; h1: number }>();
  for (const r of results) {
    if (out.get(r.round_id) == null) out.set(r.round_id, splitQuality(r.h0, r.h1));
  }
  return out;
}

/** GET /users/:handle, or null when no active or suspended account has that handle. */
export async function readProfile(
  env: Pick<Env, 'DB'>,
  handle: string,
  t: number,
): Promise<UserProfileResponse | null> {
  const db = env.DB;
  // users.handle is COLLATE NOCASE: the match is case-insensitive.
  const user = await db
    .prepare(
      `SELECT id, handle, display_name, avatar_url, created_at, prefs_json FROM users
       WHERE handle = ?1 AND status IN ('active', 'suspended')`,
    )
    .bind(handle)
    .first<UserRow>();
  if (!user) return null;

  const [stats, questions, recent] = await Promise.all([
    db
      .prepare(
        `SELECT mode, rounds_played, wins, losses, refunds, stray_streak, best_stray_streak,
                play_streak, net
         FROM user_stats WHERE user_id = ?1 ORDER BY mode`,
      )
      .bind(user.id)
      .all<StatsRow>(),
    db
      .prepare(
        `SELECT q.id, q.prompt, q.options_json, q.status, r.id AS round_id
         FROM questions q
         LEFT JOIN rounds r ON r.question_id = q.id AND r.kind = 'daily' AND r.locked_at IS NOT NULL
         WHERE q.author_user_id = ?1 AND q.room_id IS NULL
           AND (q.status = 'queued' OR (q.status = 'used' AND r.opens_at <= ?2))
         ORDER BY q.created_at DESC, q.id LIMIT ?3`,
      )
      .bind(user.id, t, PROFILE_LIMITS.questions)
      .all<QuestionRow>(),
    db
      .prepare(
        `SELECT e.round_id, e.mode, r.closes_at, m.status, m.revealed_at, e.valid, e.option_index,
                json_extract(s.winners_json, '$.winner') AS winner
         FROM entries e
         JOIN rounds r ON r.id = e.round_id AND r.kind = 'daily'
         JOIN round_modes m ON m.round_id = e.round_id AND m.mode = e.mode
           AND m.status IN ('settled', 'refunded', 'voided')
         LEFT JOIN settlements s ON s.round_id = e.round_id AND s.mode = e.mode
           AND s.superseded_at IS NULL
         WHERE e.user_id = ?1 AND e.foreign_entry = 0
         ORDER BY r.closes_at DESC, e.mode LIMIT ?2`,
      )
      .bind(user.id, PROFILE_LIMITS.recent)
      .all<RecentRow>(),
  ]);

  const quality = await splitQualities(
    db,
    questions.results.flatMap((q) => (q.round_id ? [q.round_id] : [])),
  );

  return {
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    },
    stats: stats.results.map((s): UserModeStats => ({
      mode: s.mode,
      roundsPlayed: s.rounds_played,
      wins: s.wins,
      losses: s.losses,
      refunds: s.refunds,
      strayStreak: s.stray_streak,
      bestStrayStreak: s.best_stray_streak,
      playStreak: s.play_streak,
      net: showsNet(s.mode, user.prefs_json) ? String(s.net) : null,
    })),
    questions: questions.results.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: OptionsSchema.parse(JSON.parse(q.options_json)),
      status: q.status,
      roundId: q.round_id,
      splitQuality: q.round_id ? (quality.get(q.round_id) ?? null) : null,
    })),
    recent: recent.results.map((r) => ({
      roundId: r.round_id,
      gameDay: gameDayOf(Math.floor(r.closes_at / 1000)),
      mode: r.mode,
      result: resultOf(r),
    })),
  };
}
