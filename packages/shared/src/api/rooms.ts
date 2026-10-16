// Rooms (route module `rooms`). Spec: "API", "Profiles, leaderboards and rooms" (Rooms),
// "Data model" (`rooms`, `room_members`).

import { z } from 'zod';

import { DecimalBigintSchema, EpochMsSchema, UlidSchema } from '../wire';
import { PublicUserSchema } from './auth';
import { ModerationOutcomeSchema, QuestionInputSchema, QuestionSchema } from './questions';
import { RoundViewSchema } from './rounds';

/** `rooms.question_source`. */
export const ROOM_QUESTION_SOURCES = ['daily', 'custom'] as const;
export type RoomQuestionSource = (typeof ROOM_QUESTION_SOURCES)[number];

/** `room_members.role`. */
export const ROOM_ROLES = ['owner', 'member'] as const;
export type RoomRole = (typeof ROOM_ROLES)[number];

/** Members per room by default (spec "Profiles, leaderboards and rooms" › Rooms). */
export const ROOM_MAX_MEMBERS = 50;

/**
 * The room minimum: a room round refunds (rule 1) unless it has at least this many qualifying
 * entrants (valid entries from distinct users whose accounts were at least 24 hours old at
 * `closesAt`). Locked as the room round's `minEntrants` in every mode.
 */
export const ROOM_MIN_QUALIFYING_ENTRANTS = 3;

/** A qualifying entrant's account is at least this old at `closesAt`. */
export const ROOM_QUALIFYING_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

/** An invite code. */
export const InviteCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{6,32}$/, 'expected an invite code');

/** A room as its members see it. */
export const RoomSchema = z.object({
  id: UlidSchema,
  name: z.string().min(1).max(48),
  ownerUserId: UlidSchema,
  inviteCode: InviteCodeSchema,
  questionSource: z.enum(ROOM_QUESTION_SOURCES),
  memberCount: z.int().min(1),
  createdAt: EpochMsSchema,
});
export type Room = z.infer<typeof RoomSchema>;

// POST /rooms -----------------------------------------------------------------------------------

/** POST /rooms: the owner gets the joining room points at creation. */
export const CreateRoomRequestSchema = z.strictObject({
  name: z.string().min(1).max(48),
  questionSource: z.enum(ROOM_QUESTION_SOURCES),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;
export const CreateRoomResponseSchema = z.object({ room: RoomSchema });
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

// POST /rooms/join ------------------------------------------------------------------------------

/** POST /rooms/join: `{ inviteCode }`. Joining twice returns the room. */
export const JoinRoomRequestSchema = z.strictObject({ inviteCode: InviteCodeSchema });
export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>;
export const JoinRoomResponseSchema = z.object({ room: RoomSchema });
export type JoinRoomResponse = z.infer<typeof JoinRoomResponseSchema>;

// GET /rooms/:id (members only) -----------------------------------------------------------------

/** One member and their room-points balance. */
export const RoomMemberSchema = z.object({
  user: PublicUserSchema,
  role: z.enum(ROOM_ROLES),
  joinedAt: EpochMsSchema,
  balance: DecimalBigintSchema,
});
export type RoomMember = z.infer<typeof RoomMemberSchema>;

/**
 * One row of the room leaderboard: members ranked by room-points balance (equal balances share a
 * rank), with their room-round wins this week (ISO week of the game day) and their current room
 * streak (consecutive settled room rounds won; refunded and voided rounds are neutral).
 */
export const RoomLeaderboardRowSchema = z.object({
  rank: z.int().min(1),
  user: PublicUserSchema,
  balance: DecimalBigintSchema,
  winsThisWeek: z.int().min(0),
  streak: z.int().min(0),
});
export type RoomLeaderboardRow = z.infer<typeof RoomLeaderboardRowSchema>;

/**
 * Member picks for one room round, served only once the round's Free mode has revealed (reveal
 * gating). `option` is null for an invalid (VOID) entry.
 */
export const RoomPicksSchema = z.object({
  roundId: UlidSchema,
  picks: z.array(
    z.object({ user: PublicUserSchema, option: z.union([z.literal(0), z.literal(1)]).nullable() }),
  ),
});
export type RoomPicks = z.infer<typeof RoomPicksSchema>;

/** GET /rooms/:id: room detail, members, current round and the room leaderboard. */
export const RoomDetailResponseSchema = z.object({
  room: RoomSchema,
  members: z.array(RoomMemberSchema),
  /** The room round open now, else the latest one that has opened; null before the first. */
  currentRound: RoundViewSchema.nullable(),
  /** Members ranked by room-points balance. */
  leaderboard: z.array(RoomLeaderboardRowSchema),
  /** The picks of the latest room round whose Free mode has revealed; null before the first reveal. */
  memberPicks: RoomPicksSchema.nullable(),
});
export type RoomDetailResponse = z.infer<typeof RoomDetailResponseSchema>;

// POST /rooms/:id/questions (owner only) --------------------------------------------------------

/** POST /rooms/:id/questions: the next room round's custom question; moderated like any other. */
export const SetRoomQuestionRequestSchema = QuestionInputSchema;
export type SetRoomQuestionRequest = z.infer<typeof SetRoomQuestionRequestSchema>;
export const SetRoomQuestionResponseSchema = z.object({
  question: QuestionSchema,
  moderation: ModerationOutcomeSchema,
  /** The room round the question is set on. */
  roundId: UlidSchema,
});
export type SetRoomQuestionResponse = z.infer<typeof SetRoomQuestionResponseSchema>;
