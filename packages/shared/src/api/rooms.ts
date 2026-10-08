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

/** GET /rooms/:id: room detail, members, current round and the room leaderboard. */
export const RoomDetailResponseSchema = z.object({
  room: RoomSchema,
  members: z.array(RoomMemberSchema),
  currentRound: RoundViewSchema.nullable(),
  /** Members ranked by room-points balance. */
  leaderboard: z.array(
    z.object({ rank: z.int().min(1), user: PublicUserSchema, balance: DecimalBigintSchema }),
  ),
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
