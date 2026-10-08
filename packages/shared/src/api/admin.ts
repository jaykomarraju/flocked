// Admin API (route module `admin`, auth `admin`). Spec: "API", "Admin console".
//
// The spec's API table names one admin endpoint (`POST /admin/users/:id/role`) and a catch-all
// row (`* /admin/*`, "See Admin console"). The console section lists actions, not paths, so the
// other endpoints here are a W2-D draft, one per console action. W11-A (Admin API) may reshape
// them; `ENDPOINTS` is the single list to update when it does.

import { z } from 'zod';

import {
  BpsSchema,
  CategorySchema,
  CountSchema,
  CursorSchema,
  DecimalBigintSchema,
  EpochMsSchema,
  GameDaySchema,
  Hex32Schema,
  LimitQuerySchema,
  ModeSchema,
  ModeStatusSchema,
  NotificationEventSchema,
  RoundStatusSchema,
  SignedDecimalBigintSchema,
  UlidSchema,
  UserRoleSchema,
  UserStatusSchema,
} from '../wire';
import { PublicUserSchema } from './auth';
import { LimitsStateSchema } from './limits';
import { IdentitySchema, MergeSchema } from './me';
import {
  QuestionInputSchema,
  QuestionOptionInputSchema,
  QuestionSchema,
  QuestionStatusSchema,
} from './questions';
import { RoundConfigWireSchema, perModeSchema } from './rounds';

/** An `audit_log` row ID; every admin action returns the row it wrote. */
export const AuditIdSchema = z.string().min(1).max(64);

/** A required reason for an admin action. */
const ReasonSchema = z.string().min(1).max(500);

/** A user as the console lists them. */
export const AdminUserRowSchema = PublicUserSchema.extend({
  role: UserRoleSchema,
  status: UserStatusSchema,
  personVerified: z.boolean(),
  createdAt: EpochMsSchema,
});
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;

/** Params for `/admin/users/:id/...` routes. */
export const AdminUserParamsSchema = z.object({ id: UlidSchema });

// POST /admin/users/:id/role (spec row) ---------------------------------------------------------

/** POST /admin/users/:id/role: set the user's role. */
export const SetUserRoleRequestSchema = z.strictObject({ role: UserRoleSchema });
export type SetUserRoleRequest = z.infer<typeof SetUserRoleRequestSchema>;
export const SetUserRoleResponseSchema = z.object({
  userId: UlidSchema,
  role: UserRoleSchema,
  auditId: AuditIdSchema,
});
export type SetUserRoleResponse = z.infer<typeof SetUserRoleResponseSchema>;

// Schedule (draft) ------------------------------------------------------------------------------

/** GET /admin/schedule query: an inclusive game-day range. */
export const AdminScheduleQuerySchema = z.object({ from: GameDaySchema, to: GameDaySchema });
export type AdminScheduleQuery = z.infer<typeof AdminScheduleQuerySchema>;

/** GET /admin/schedule: one entry per game day, with its daily round if one exists. */
export const AdminScheduleResponseSchema = z.object({
  days: z.array(
    z.object({
      gameDay: GameDaySchema,
      round: z
        .object({
          id: UlidSchema,
          status: RoundStatusSchema,
          lockedAt: EpochMsSchema.nullable(),
          question: z.object({ id: UlidSchema, prompt: z.string() }).nullable(),
          modes: perModeSchema(ModeStatusSchema),
        })
        .nullable(),
    }),
  ),
});
export type AdminScheduleResponse = z.infer<typeof AdminScheduleResponseSchema>;

/** PUT /admin/schedule/:gameDay path params. */
export const AdminScheduleDayParamsSchema = z.object({ gameDay: GameDaySchema });

/** PUT /admin/schedule/:gameDay: assign a queued question to a day (before question lock). */
export const AssignQuestionRequestSchema = z.strictObject({ questionId: UlidSchema });
export type AssignQuestionRequest = z.infer<typeof AssignQuestionRequestSchema>;
export const AssignQuestionResponseSchema = z.object({
  gameDay: GameDaySchema,
  roundId: UlidSchema,
  questionId: UlidSchema,
  auditId: AuditIdSchema,
});
export type AssignQuestionResponse = z.infer<typeof AssignQuestionResponseSchema>;

/** PATCH /admin/rounds/:id/config: edit round config until question lock. */
export const EditRoundConfigRequestSchema = z.strictObject({
  free: z
    .strictObject({
      stakeMin: DecimalBigintSchema,
      stakeMax: DecimalBigintSchema,
      capMultiple: z.int().min(1).max(255),
      minEntrants: z.int().min(1),
      creatorAwardBps: BpsSchema,
    })
    .partial()
    .optional(),
  stakes: z
    .strictObject({
      stake: DecimalBigintSchema,
      feeBps: BpsSchema,
      creatorBps: BpsSchema,
      capMultiple: z.int().min(1).max(255),
      minEntrants: z.int().min(1),
    })
    .partial()
    .optional(),
  reason: ReasonSchema,
});
export type EditRoundConfigRequest = z.infer<typeof EditRoundConfigRequestSchema>;
export const EditRoundConfigResponseSchema = z.object({
  roundId: UlidSchema,
  config: RoundConfigWireSchema,
  auditId: AuditIdSchema,
});
export type EditRoundConfigResponse = z.infer<typeof EditRoundConfigResponseSchema>;

// Question queue (draft) ------------------------------------------------------------------------

/** GET /admin/questions query. */
export const AdminQuestionsQuerySchema = z.object({
  status: QuestionStatusSchema.optional(),
  cursor: CursorSchema.optional(),
  limit: LimitQuerySchema.optional(),
});
export type AdminQuestionsQuery = z.infer<typeof AdminQuestionsQuerySchema>;

/** A queued question with its moderation JSON and predicted split (option 0 share, 0..1). */
export const AdminQuestionSchema = QuestionSchema.extend({
  moderation: z.record(z.string(), z.unknown()).nullable(),
  predictedSplit: z.number().min(0).max(1).nullable(),
});
export type AdminQuestion = z.infer<typeof AdminQuestionSchema>;

/** GET /admin/questions: top-scored submissions first. */
export const AdminQuestionsResponseSchema = z.object({
  questions: z.array(AdminQuestionSchema),
  nextCursor: CursorSchema.nullable(),
});
export type AdminQuestionsResponse = z.infer<typeof AdminQuestionsResponseSchema>;

/** POST /admin/questions: add a house question (no author). */
export const AddHouseQuestionRequestSchema = QuestionInputSchema;
export type AddHouseQuestionRequest = z.infer<typeof AddHouseQuestionRequestSchema>;
export const AddHouseQuestionResponseSchema = z.object({
  question: AdminQuestionSchema,
  auditId: AuditIdSchema,
});
export type AddHouseQuestionResponse = z.infer<typeof AddHouseQuestionResponseSchema>;

/** PATCH /admin/questions/:id: edit wording; the author gets `question_edited`. */
export const EditQuestionRequestSchema = z.strictObject({
  prompt: z.string().min(1).max(120).optional(),
  options: z.tuple([QuestionOptionInputSchema, QuestionOptionInputSchema]).optional(),
  category: CategorySchema.optional(),
  reason: ReasonSchema,
});
export type EditQuestionRequest = z.infer<typeof EditQuestionRequestSchema>;

/** Response of every question moderation action. */
export const AdminQuestionActionResponseSchema = z.object({
  question: AdminQuestionSchema,
  auditId: AuditIdSchema,
});
export type AdminQuestionActionResponse = z.infer<typeof AdminQuestionActionResponseSchema>;
export const EditQuestionResponseSchema = AdminQuestionActionResponseSchema;

/** POST /admin/questions/:id/approve: no body. */
export const ApproveQuestionResponseSchema = AdminQuestionActionResponseSchema;

/** POST /admin/questions/:id/reject: the reason is shown to the author. */
export const RejectQuestionRequestSchema = z.strictObject({ reason: ReasonSchema });
export type RejectQuestionRequest = z.infer<typeof RejectQuestionRequestSchema>;
export const RejectQuestionResponseSchema = AdminQuestionActionResponseSchema;

// Live round and interventions (draft) ----------------------------------------------------------

/** `anchors.kind`. */
export const ANCHOR_KINDS = ['lock', 'commit', 'manifest'] as const;

/** GET /admin/rounds/:id/live: status per mode, counters and health. */
export const AdminLiveRoundResponseSchema = z.object({
  roundId: UlidSchema,
  status: RoundStatusSchema,
  modes: perModeSchema(
    z.object({
      status: ModeStatusSchema,
      entrantCount: CountSchema,
      pool: DecimalBigintSchema,
      /** Free-text settlement stage (e.g. `decrypting 3/8`); null when idle. */
      settlementProgress: z.string().nullable(),
    }),
  ),
  doHealthy: z.boolean(),
  indexerLagBlocks: CountSchema.nullable(),
  safeHeadLagBlocks: CountSchema.nullable(),
  anchors: z.array(
    z.object({
      kind: z.enum(ANCHOR_KINDS),
      status: z.enum(['pending', 'confirmed', 'skipped', 'missing']),
      txHash: Hex32Schema.nullable(),
    }),
  ),
});
export type AdminLiveRoundResponse = z.infer<typeof AdminLiveRoundResponseSchema>;

/** POST /admin/rounds/:id/void: only before `closesAt` (`void_after_close` otherwise). */
export const VoidRoundRequestSchema = z.strictObject({ reason: ReasonSchema });
export type VoidRoundRequest = z.infer<typeof VoidRoundRequestSchema>;
export const VoidRoundResponseSchema = z.object({ roundId: UlidSchema, auditId: AuditIdSchema });
export type VoidRoundResponse = z.infer<typeof VoidRoundResponseSchema>;

/** POST /admin/rounds/:id/settlement/retry: re-enqueue settlement for one mode. */
export const RetrySettlementRequestSchema = z.strictObject({ mode: ModeSchema });
export type RetrySettlementRequest = z.infer<typeof RetrySettlementRequestSchema>;
export const RetrySettlementResponseSchema = z.object({
  roundId: UlidSchema,
  mode: ModeSchema,
  auditId: AuditIdSchema,
});
export type RetrySettlementResponse = z.infer<typeof RetrySettlementResponseSchema>;

/** POST /admin/contract/pause: pause `FlockedEscrow` (blocks new entries only). */
export const PauseContractRequestSchema = z.strictObject({ reason: ReasonSchema });
export type PauseContractRequest = z.infer<typeof PauseContractRequestSchema>;
export const PauseContractResponseSchema = z.object({
  txHash: Hex32Schema.nullable(),
  auditId: AuditIdSchema,
});
export type PauseContractResponse = z.infer<typeof PauseContractResponseSchema>;

/** GET /admin/challenges: every Stakes proposal inside its window, with the watcher's verdict. */
export const AdminChallengesResponseSchema = z.object({
  proposals: z.array(
    z.object({
      roundId: UlidSchema,
      chainRoundId: DecimalBigintSchema,
      kind: z.enum(['settle', 'refund']),
      txHash: Hex32Schema,
      proposedAt: EpochMsSchema,
      challengeEndsAt: EpochMsSchema,
      verdict: z
        .object({
          verdict: z.enum(['match', 'mismatch', 'unable']),
          reasons: z.array(z.string()),
          checkedAt: EpochMsSchema,
        })
        .nullable(),
    }),
  ),
});
export type AdminChallengesResponse = z.infer<typeof AdminChallengesResponseSchema>;

// Users (draft) ---------------------------------------------------------------------------------

/** GET /admin/users query: search by handle, ID, address or email. */
export const AdminUsersQuerySchema = z.object({
  q: z.string().min(1).max(256),
  cursor: CursorSchema.optional(),
  limit: LimitQuerySchema.optional(),
});
export type AdminUsersQuery = z.infer<typeof AdminUsersQuerySchema>;
export const AdminUsersResponseSchema = z.object({
  users: z.array(AdminUserRowSchema),
  nextCursor: CursorSchema.nullable(),
});
export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;

/** `points_ledger.reason`. Spec: "Data model". */
export const LEDGER_REASONS = [
  'signup',
  'daily_grant',
  'room_grant',
  'stake',
  'payout',
  'rebate',
  'refund',
  'void_refund',
  'creator_award',
  'referral',
  'merge',
  'admin',
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

/** A points scope: `global` or a room ID. */
export const PointsScopeSchema = z.union([z.literal('global'), UlidSchema]);

/** GET /admin/users/:id: identities, merges, entries, ledger and limits. */
export const AdminUserDetailResponseSchema = z.object({
  user: AdminUserRowSchema,
  identities: z.array(IdentitySchema),
  merges: z.array(MergeSchema),
  entries: z.array(
    z.object({
      id: UlidSchema,
      roundId: UlidSchema,
      mode: ModeSchema,
      stake: DecimalBigintSchema,
      valid: z.boolean().nullable(),
      createdAt: EpochMsSchema,
    }),
  ),
  ledger: z.array(
    z.object({
      id: UlidSchema,
      scope: PointsScopeSchema,
      delta: SignedDecimalBigintSchema,
      reason: z.enum(LEDGER_REASONS),
      refId: z.string().nullable(),
      createdAt: EpochMsSchema,
    }),
  ),
  limits: LimitsStateSchema,
});
export type AdminUserDetailResponse = z.infer<typeof AdminUserDetailResponseSchema>;

/** POST /admin/users/:id/status: suspend or unsuspend. */
export const SetUserStatusRequestSchema = z.strictObject({
  status: z.enum(['active', 'suspended']),
  reason: ReasonSchema,
});
export type SetUserStatusRequest = z.infer<typeof SetUserStatusRequestSchema>;
export const SetUserStatusResponseSchema = z.object({
  userId: UlidSchema,
  status: UserStatusSchema,
  auditId: AuditIdSchema,
});
export type SetUserStatusResponse = z.infer<typeof SetUserStatusResponseSchema>;

/** POST /admin/users/:id/points: a manual adjustment (non-zero delta, required reason). */
export const AdjustPointsRequestSchema = z.strictObject({
  scope: PointsScopeSchema,
  delta: SignedDecimalBigintSchema.refine((d) => d !== '0', 'delta must be non-zero'),
  reason: ReasonSchema,
});
export type AdjustPointsRequest = z.infer<typeof AdjustPointsRequestSchema>;
export const AdjustPointsResponseSchema = z.object({
  userId: UlidSchema,
  scope: PointsScopeSchema,
  balance: DecimalBigintSchema,
  auditId: AuditIdSchema,
});
export type AdjustPointsResponse = z.infer<typeof AdjustPointsResponseSchema>;

// Flags and config (draft) ----------------------------------------------------------------------

/**
 * Feature flags, geo lists (ISO 3166-1 alpha-2 country, or `CC-RR` for a region), fee defaults
 * and notification copy overrides. A change affects rounds locked after it, except the Stakes
 * kill switch.
 */
export const AdminConfigSchema = z.object({
  flags: z.record(z.string(), z.boolean()),
  geo: z.object({
    stakesAllow: z.array(z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/)),
    deny: z.array(z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/)),
  }),
  feeDefaults: z.object({
    free: z.object({
      stakeMin: DecimalBigintSchema,
      stakeMax: DecimalBigintSchema,
      capMultiple: z.int().min(1).max(255),
      minEntrants: z.int().min(1),
      creatorAwardBps: BpsSchema,
    }),
    stakes: z.object({
      stake: DecimalBigintSchema,
      feeBps: BpsSchema,
      creatorBps: BpsSchema,
      capMultiple: z.int().min(1).max(255),
      minEntrants: z.int().min(1),
    }),
  }),
  notificationCopy: z.partialRecord(NotificationEventSchema, z.string().min(1)),
});
export type AdminConfig = z.infer<typeof AdminConfigSchema>;

/** GET /admin/config. */
export const AdminConfigResponseSchema = AdminConfigSchema;

/** PUT /admin/config: replaces the whole config; the response is the stored config. */
export const UpdateAdminConfigRequestSchema = AdminConfigSchema.extend({ reason: ReasonSchema });
export type UpdateAdminConfigRequest = z.infer<typeof UpdateAdminConfigRequestSchema>;
export const UpdateAdminConfigResponseSchema = AdminConfigSchema.extend({ auditId: AuditIdSchema });
export type UpdateAdminConfigResponse = z.infer<typeof UpdateAdminConfigResponseSchema>;
