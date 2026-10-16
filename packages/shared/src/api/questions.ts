// The question queue (route module `questions`). Spec: "API", "Core game rules" (Question format),
// "Question pipeline", "Data model" (`questions`, `question_votes`).

import { z } from 'zod';

import {
  CategorySchema,
  CursorSchema,
  EpochMsSchema,
  LimitQuerySchema,
  TurnstileTokenSchema,
  UlidSchema,
} from '../wire';
import { PublicUserSchema } from './auth';

/** `questions.status`. Spec: "Data model". */
export const QUESTION_STATUSES = ['submitted', 'rejected', 'queued', 'scheduled', 'used'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);

/** One option as stored and served (`options_json` entry). `emoji` is `""` when there is none. */
export const QuestionOptionSchema = z.object({
  label: z.string().min(1).max(24),
  emoji: z.string().max(16),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** One option as submitted: 1-24 characters and an optional single emoji. */
export const QuestionOptionInputSchema = z.strictObject({
  label: z.string().min(1).max(24),
  emoji: z.string().min(1).max(16).optional(),
});
export type QuestionOptionInput = z.infer<typeof QuestionOptionInputSchema>;

const normalizeLabel = (s: string) => s.trim().normalize('NFC').toLowerCase();

/** The fields of a submitted question. */
export const questionInputShape = {
  prompt: z.string().min(1).max(120),
  options: z.tuple([QuestionOptionInputSchema, QuestionOptionInputSchema]),
  category: CategorySchema,
};

/** True when the two option labels differ after trimming and case folding (spec rule). */
export function optionsDiffer(q: { options: readonly [{ label: string }, { label: string }] }) {
  return normalizeLabel(q.options[0].label) !== normalizeLabel(q.options[1].label);
}
const optionsDifferIssue = { message: 'the two options must differ', path: ['options'] };

/**
 * A question as submitted (users, room owners, admins): prompt 1-120 characters, exactly two
 * options that differ after trimming and case folding.
 */
export const QuestionInputSchema = z
  .strictObject(questionInputShape)
  .refine(optionsDiffer, optionsDifferIssue);
export type QuestionInput = z.infer<typeof QuestionInputSchema>;

/** A question as served. */
export const QuestionSchema = z.object({
  id: UlidSchema,
  prompt: z.string().min(1),
  options: z.tuple([QuestionOptionSchema, QuestionOptionSchema]),
  category: CategorySchema,
  status: QuestionStatusSchema,
  score: z.int(),
  /** Null for house questions. */
  author: PublicUserSchema.nullable(),
  createdAt: EpochMsSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

/** Submissions per user per game day (spec "Question pipeline" step 1). */
export const QUESTIONS_PER_DAY = 3;
/** Rejections within `QUESTION_REJECTION_WINDOW_MS` that block submission (spec "Anti-abuse"). */
export const QUESTION_REJECTION_LIMIT = 5;
export const QUESTION_REJECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** How long submission stays blocked after the 5th rejection. */
export const QUESTION_BLOCK_MS = 7 * 24 * 60 * 60 * 1000;
/** The queue page shows the top 50 (spec "Question pipeline" step 3). */
export const QUEUE_TOP_LIMIT = 50;

/**
 * The caller's submission allowance: what's left in the current game day (21:00 to 21:00 New
 * York), rejections in the last 7 days, and the end of a 7-day block (null when not blocked).
 */
export const QuestionQuotaSchema = z.object({
  remainingToday: z.int().min(0).max(QUESTIONS_PER_DAY),
  rejectionsLast7Days: z.int().min(0),
  blockedUntil: EpochMsSchema.nullable(),
});
export type QuestionQuota = z.infer<typeof QuestionQuotaSchema>;

/** The synchronous moderation outcome of a submission. `review` goes to the admin queue. */
export const ModerationOutcomeSchema = z.object({
  outcome: z.enum(['queued', 'rejected', 'review']),
  /** The rejection reason shown to the author; null otherwise. */
  reason: z.string().nullable(),
});
export type ModerationOutcome = z.infer<typeof ModerationOutcomeSchema>;

// GET /questions?status=queued&sort=top ---------------------------------------------------------

export const QUESTION_SORTS = ['top', 'new'] as const;

/**
 * GET /questions query. Only public statuses can be listed; the default is `queued`, `top`.
 * `queued` is the voting queue: questions that passed moderation and wait for a day (`submitted`
 * without a pending review, and admin-approved `queued` ones). `top` serves at most the top 50 by
 * decayed score, in one page; `new` pages by creation time.
 */
export const QuestionsListQuerySchema = z.object({
  status: z.enum(['queued', 'scheduled', 'used']).optional(),
  sort: z.enum(QUESTION_SORTS).optional(),
  cursor: CursorSchema.optional(),
  limit: LimitQuerySchema.optional(),
});
export type QuestionsListQuery = z.infer<typeof QuestionsListQuerySchema>;

/**
 * GET /questions response. `myVote` is the caller's vote when signed in, else null; `quota` is the
 * caller's submission allowance when signed in, else null.
 */
export const QuestionsListResponseSchema = z.object({
  questions: z.array(
    QuestionSchema.extend({ myVote: z.union([z.literal(1), z.literal(-1)]).nullable() }),
  ),
  nextCursor: CursorSchema.nullable(),
  quota: QuestionQuotaSchema.nullable(),
});
export type QuestionsListResponse = z.infer<typeof QuestionsListResponseSchema>;

// POST /questions -------------------------------------------------------------------------------

/** POST /questions: submit a question; moderation runs before the response. */
export const SubmitQuestionRequestSchema = z
  .strictObject({ ...questionInputShape, turnstileToken: TurnstileTokenSchema.optional() })
  .refine(optionsDiffer, optionsDifferIssue);
export type SubmitQuestionRequest = z.infer<typeof SubmitQuestionRequestSchema>;
/** The stored question (status `rejected` when moderation rejected it), its outcome and the quota after it. */
export const SubmitQuestionResponseSchema = z.object({
  question: QuestionSchema,
  moderation: ModerationOutcomeSchema,
  quota: QuestionQuotaSchema,
});
export type SubmitQuestionResponse = z.infer<typeof SubmitQuestionResponseSchema>;

// POST /questions/:id/vote ----------------------------------------------------------------------

/** POST /questions/:id/vote: `{ value: 1 | -1 }`; a repeat vote replaces the earlier one. */
export const VoteQuestionRequestSchema = z.strictObject({
  value: z.union([z.literal(1), z.literal(-1)]),
});
export type VoteQuestionRequest = z.infer<typeof VoteQuestionRequestSchema>;
export const VoteQuestionResponseSchema = z.object({
  questionId: UlidSchema,
  value: z.union([z.literal(1), z.literal(-1)]),
  score: z.int(),
});
export type VoteQuestionResponse = z.infer<typeof VoteQuestionResponseSchema>;
