// Leaderboards (route module `boards`) and public profiles (route module `users`, kept here with
// the other social reads). Spec: "API", "Profiles, leaderboards and rooms", "Data model"
// (`user_stats`).

import { z } from 'zod';

import {
  CountSchema,
  EpochMsSchema,
  GameDaySchema,
  HandleSchema,
  IsoWeekSchema,
  ModeSchema,
  SignedDecimalBigintSchema,
  UlidSchema,
} from '../wire';
import { PublicUserSchema } from './auth';
import { ENTRY_RESULTS } from './entries';
import { QuestionOptionSchema, QuestionStatusSchema } from './questions';

/** Board names. Spec: "Profiles, leaderboards and rooms" (Leaderboards). */
export const BOARDS = ['strays', 'streaks', 'weekly', 'creators'] as const;
export type Board = (typeof BOARDS)[number];
export const BoardSchema = z.enum(BOARDS);

/** A split-quality score, 0..1 (1 = an even split). */
export const SplitQualitySchema = z.number().min(0).max(1);

// GET /leaderboards/:board?mode=&period= --------------------------------------------------------

/** GET /leaderboards/:board path params. */
export const LeaderboardParamsSchema = z.object({ board: BoardSchema });
export type LeaderboardParams = z.infer<typeof LeaderboardParamsSchema>;

/**
 * GET /leaderboards/:board query. `mode` defaults to `free`. `period` is a game day for
 * `strays`, an ISO week for `weekly`, and ignored for `streaks` (live) and `creators` (all time);
 * it defaults to the current one.
 */
export const LeaderboardQuerySchema = z.object({
  mode: ModeSchema.optional(),
  period: z.union([GameDaySchema, IsoWeekSchema]).optional(),
});
export type LeaderboardQuery = z.infer<typeof LeaderboardQuerySchema>;

/**
 * One board row. Each board fills the metrics it ranks and breaks ties by:
 * strays: `strayStreak`, `bestStrayStreak`, `enteredAt`; streaks: `strayStreak`,
 * `bestStrayStreak`, `roundsPlayed`; weekly: `wins`, `net`; creators: `splitQuality`,
 * `usedQuestions`.
 */
export const LeaderboardRowSchema = z.object({
  rank: z.int().min(1),
  user: PublicUserSchema,
  strayStreak: CountSchema.optional(),
  bestStrayStreak: CountSchema.optional(),
  roundsPlayed: CountSchema.optional(),
  enteredAt: EpochMsSchema.optional(),
  wins: CountSchema.optional(),
  net: SignedDecimalBigintSchema.optional(),
  splitQuality: SplitQualitySchema.optional(),
  usedQuestions: CountSchema.optional(),
});
export type LeaderboardRow = z.infer<typeof LeaderboardRowSchema>;

/** GET /leaderboards/:board response. `me` is the caller's row when signed in and ranked. */
export const LeaderboardResponseSchema = z.object({
  board: BoardSchema,
  mode: ModeSchema,
  period: z.union([GameDaySchema, IsoWeekSchema]).nullable(),
  rows: z.array(LeaderboardRowSchema),
  me: LeaderboardRowSchema.nullable(),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

// GET /users/:handle (module `users`) -----------------------------------------------------------

/** GET /users/:handle path params. */
export const UserProfileParamsSchema = z.object({ handle: HandleSchema });
export type UserProfileParams = z.infer<typeof UserProfileParamsSchema>;

/** Per-mode public stats (`user_stats`, daily rounds only). */
export const UserModeStatsSchema = z.object({
  mode: ModeSchema,
  roundsPlayed: CountSchema,
  wins: CountSchema,
  losses: CountSchema,
  refunds: CountSchema,
  strayStreak: CountSchema,
  bestStrayStreak: CountSchema,
  playStreak: CountSchema,
  /** Points or USDC base units. Stakes net is null unless the user opted in. */
  net: SignedDecimalBigintSchema.nullable(),
});
export type UserModeStats = z.infer<typeof UserModeStatsSchema>;

/** GET /users/:handle: public profile, stats per mode, authored questions, recent results. */
export const UserProfileResponseSchema = z.object({
  user: PublicUserSchema.extend({ createdAt: EpochMsSchema }),
  stats: z.array(UserModeStatsSchema),
  questions: z.array(
    z.object({
      id: UlidSchema,
      prompt: z.string().min(1),
      options: z.tuple([QuestionOptionSchema, QuestionOptionSchema]),
      status: QuestionStatusSchema,
      roundId: UlidSchema.nullable(),
      /** Null until the question's round has revealed. */
      splitQuality: SplitQualitySchema.nullable(),
    }),
  ),
  recent: z.array(
    z.object({
      roundId: UlidSchema,
      gameDay: GameDaySchema,
      mode: ModeSchema,
      result: z.enum(ENTRY_RESULTS),
    }),
  ),
});
export type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;
