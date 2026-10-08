// Cloudflare Queue message shapes. Plan P2.4. Spec: "Architecture", "Real-time and the reveal",
// "Share cards and distribution", "Notifications".

import { z } from 'zod';

import { CARD_KINDS, CARD_VARIANTS } from './api/cards';
import { ENTRY_RESULTS } from './api/entries';
import {
  DecimalBigintSchema,
  EpochMsSchema,
  GameDaySchema,
  ModeSchema,
  RefundReasonCodeSchema,
  SignedDecimalBigintSchema,
  UlidSchema,
  UnixSecondsSchema,
} from './wire';

/** Queue names, as bound in `apps/api/wrangler.jsonc`. */
export const QUEUE_NAMES = ['settle', 'decrypt-daily', 'decrypt-rooms', 'cards', 'notify'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * `settle`: run settlement for one mode. `idempotencyKey` identifies the (roundId, mode) job, so
 * a redelivered or re-enqueued message settles once.
 */
export const SettleMessageSchema = z.object({
  roundId: UlidSchema,
  mode: ModeSchema,
  idempotencyKey: z.string().min(1).max(256),
});
export type SettleMessage = z.infer<typeof SettleMessageSchema>;

/** `decrypt-daily` and `decrypt-rooms`: decrypt one chunk of entries (`chunkKey` is its R2 key). */
export const DecryptMessageSchema = z.object({
  roundId: UlidSchema,
  mode: ModeSchema,
  chunkKey: z.string().min(1).max(1024),
});
export type DecryptMessage = z.infer<typeof DecryptMessageSchema>;

/**
 * `cards`: render share cards. `kind` is `result` or `teaser` (a player's card, `userId` set) or
 * `round` (the generic split card, no `userId`); R2 keys per plan wave 10. `variants` lists the
 * images to render (all three at the reveal; one when rendering on demand).
 */
export const CardsMessageSchema = z
  .object({
    roundId: UlidSchema,
    mode: ModeSchema,
    userId: UlidSchema.optional(),
    kind: z.enum(CARD_KINDS),
    variants: z.array(z.enum(CARD_VARIANTS)).min(1).max(CARD_VARIANTS.length),
  })
  .refine((m) => (m.kind === 'round') === (m.userId === undefined), {
    message: 'userId is required for result and teaser cards and absent for round cards',
    path: ['userId'],
  })
  .refine((m) => new Set(m.variants).size === m.variants.length, {
    message: 'duplicate variant',
    path: ['variants'],
  });
export type CardsMessage = z.infer<typeof CardsMessageSchema>;

// notify ----------------------------------------------------------------------------------------

/** The common fields of a `notify` message; `dedupeKey` follows the spec's key formats. */
const notifyBase = {
  userId: UlidSchema,
  dedupeKey: z.string().min(1).max(256),
};

const notify = <E extends string, P extends z.ZodRawShape>(event: E, payload: P) =>
  z.object({ event: z.literal(event), ...notifyBase, payload: z.object(payload) });

/** Security notice kinds (spec "Notifications": `security_notice`). */
export const SECURITY_NOTICE_KINDS = [
  'email_sign_in',
  'identity_linked',
  'merge_pending',
  'merge_completed',
] as const;

/**
 * `notify`: one notification to one user, discriminated on `event` (NOTIFICATION_EVENTS order).
 * The consumer resolves channels from `notification_prefs`.
 */
export const NotifyMessageSchema = z.discriminatedUnion('event', [
  notify('question_live', { roundId: UlidSchema, gameDay: GameDaySchema }),
  notify('closing_soon', { roundId: UlidSchema, closesAt: UnixSecondsSchema }),
  notify('outcome', {
    roundId: UlidSchema,
    gameDay: GameDaySchema,
    mode: ModeSchema,
    result: z.enum(ENTRY_RESULTS),
    /** Net change for the user (points or USDC base units); null when not shown. */
    amount: SignedDecimalBigintSchema.nullable(),
    nextRoundId: UlidSchema.nullable(),
  }),
  notify('payout_claimable', {
    roundId: UlidSchema,
    mode: z.literal('stakes'),
    amount: DecimalBigintSchema,
    claimsOpenAt: EpochMsSchema,
  }),
  notify('refunded', {
    roundId: UlidSchema,
    mode: ModeSchema,
    refundReason: RefundReasonCodeSchema,
  }),
  notify('question_used', {
    questionId: UlidSchema,
    stage: z.enum(['scheduled', 'settled']),
    roundId: UlidSchema,
  }),
  notify('streak_at_risk', {
    roundId: UlidSchema,
    strayStreak: z.int().min(3),
    closesAt: UnixSecondsSchema,
  }),
  notify('question_edited', { questionId: UlidSchema, auditId: z.string().min(1) }),
  notify('security_notice', {
    noticeId: z.string().min(1),
    kind: z.enum(SECURITY_NOTICE_KINDS),
  }),
]);
export type NotifyMessage = z.infer<typeof NotifyMessageSchema>;

/** The schema for each queue's messages. */
export const QueueMessageSchemas = {
  settle: SettleMessageSchema,
  'decrypt-daily': DecryptMessageSchema,
  'decrypt-rooms': DecryptMessageSchema,
  cards: CardsMessageSchema,
  notify: NotifyMessageSchema,
} as const satisfies Record<QueueName, z.ZodType>;

/** The message type of a queue. */
export type QueueMessage<Q extends QueueName> = z.infer<(typeof QueueMessageSchemas)[Q]>;
