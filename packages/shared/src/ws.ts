// WebSocket messages, server to client, on `GET /rounds/:id/ws`. Spec: "Real-time and the
// reveal" (WebSocket messages). The spec defines no client-to-server messages.
//
// Reveal gating: no message carries per-option data for a mode before that mode reveals.

import { z } from 'zod';

import { TallySchema, perModeSchema } from './api/rounds';
import {
  BeaconRoundSchema,
  CountSchema,
  DecimalBigintSchema,
  EpochMsSchema,
  ModeSchema,
  ModeStatusSchema,
  OptionIndexSchema,
  RefundReasonCodeSchema,
  RoundStatusSchema,
  UlidSchema,
  UnixSecondsSchema,
} from './wire';

/** Message types, in the spec's table order. */
export const WS_SERVER_MESSAGE_TYPES = [
  'state',
  'counts',
  'closed',
  'revealing',
  'revealed',
  'refunded',
] as const;
export type WsServerMessageType = (typeof WS_SERVER_MESSAGE_TYPES)[number];

/** A mode's revealed result: the winning option and per-option headcount and total stake. */
export const WsRevealResultSchema = z.object({
  winningOption: OptionIndexSchema,
  tally: TallySchema,
});
export type WsRevealResult = z.infer<typeof WsRevealResultSchema>;

/** One mode in the `state` snapshot. `result` stays null until `revealedAt` is set. */
export const WsModeSnapshotSchema = z
  .object({
    status: ModeStatusSchema,
    entrantCount: CountSchema,
    pool: DecimalBigintSchema,
    revealedAt: EpochMsSchema.nullable(),
    /** Stakes only. */
    claimsOpenAt: EpochMsSchema.nullable(),
    refundReason: RefundReasonCodeSchema.nullable(),
    result: WsRevealResultSchema.nullable(),
  })
  .refine((m) => m.result === null || m.revealedAt !== null, {
    message: 'per-option data before reveal',
    path: ['result'],
  });
export type WsModeSnapshot = z.infer<typeof WsModeSnapshotSchema>;

/**
 * `state`: the full snapshot, sent on connect. Times: `opensAt`, `closesAt`, `beaconTime` are
 * Unix seconds; `serverTime` (for countdown skew) is epoch ms.
 */
export const WsStateMessageSchema = z.object({
  type: z.literal('state'),
  roundId: UlidSchema,
  status: RoundStatusSchema,
  opensAt: UnixSecondsSchema,
  closesAt: UnixSecondsSchema,
  beaconRound: BeaconRoundSchema,
  beaconTime: UnixSecondsSchema,
  serverTime: EpochMsSchema,
  modes: perModeSchema(WsModeSnapshotSchema),
});
export type WsStateMessage = z.infer<typeof WsStateMessageSchema>;

/** `counts`: entrant count and pool per mode, no per-option data. At most once per second. */
export const WsCountsMessageSchema = z.object({
  type: z.literal('counts'),
  roundId: UlidSchema,
  modes: perModeSchema(z.object({ entrantCount: CountSchema, pool: DecimalBigintSchema })),
});
export type WsCountsMessage = z.infer<typeof WsCountsMessageSchema>;

/** `closed`: `closesAt` reached and entries locked; the beacon time drives "Unsealing in". */
export const WsClosedMessageSchema = z.object({
  type: z.literal('closed'),
  roundId: UlidSchema,
  closesAt: UnixSecondsSchema,
  beaconRound: BeaconRoundSchema,
  beaconTime: UnixSecondsSchema,
});
export type WsClosedMessage = z.infer<typeof WsClosedMessageSchema>;

/** `revealing`: settlement started for a mode. */
export const WsRevealingMessageSchema = z.object({
  type: z.literal('revealing'),
  roundId: UlidSchema,
  mode: ModeSchema,
});
export type WsRevealingMessage = z.infer<typeof WsRevealingMessageSchema>;

/**
 * `revealed`: one mode's per-option headcounts and totals and its winning option. Stakes sends
 * it once the proposal is confirmed onchain, with `claimsOpenAt` (epoch ms); Free omits it.
 */
export const WsRevealedMessageSchema = z
  .object({
    type: z.literal('revealed'),
    roundId: UlidSchema,
    mode: ModeSchema,
    winningOption: OptionIndexSchema,
    tally: TallySchema,
    claimsOpenAt: EpochMsSchema.optional(),
  })
  .refine((m) => (m.mode === 'stakes') === (m.claimsOpenAt !== undefined), {
    message: 'claimsOpenAt is required for stakes and absent for free',
    path: ['claimsOpenAt'],
  });
export type WsRevealedMessage = z.infer<typeof WsRevealedMessageSchema>;

/** `refunded`: one mode was refunded (including after a guardian veto), with its reason code. */
export const WsRefundedMessageSchema = z.object({
  type: z.literal('refunded'),
  roundId: UlidSchema,
  mode: ModeSchema,
  refundReason: RefundReasonCodeSchema,
});
export type WsRefundedMessage = z.infer<typeof WsRefundedMessageSchema>;

/** Every server-to-client message, discriminated on `type`. */
export const WsServerMessageSchema = z.discriminatedUnion('type', [
  WsStateMessageSchema,
  WsCountsMessageSchema,
  WsClosedMessageSchema,
  WsRevealingMessageSchema,
  WsRevealedMessageSchema,
  WsRefundedMessageSchema,
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
