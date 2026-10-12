// Stakes claims (route module `claims`). Spec: "API", "Smart contract", "Identity and personhood"
// (merged accounts and wallet-only claims), "Data model" (`payouts`).

import { z } from 'zod';

import {
  AddressSchema,
  DecimalBigintSchema,
  EpochMsSchema,
  Hex32Schema,
  PayoutKindSchema,
  UlidSchema,
} from '../wire';

/**
 * GET /claims query. With `wallet`, the claims are served from public bundle data without
 * sign-in; without it the caller must be signed in (auth `optional`).
 */
export const ClaimsQuerySchema = z.object({ wallet: AddressSchema.optional() });
export type ClaimsQuery = z.infer<typeof ClaimsQuerySchema>;

/**
 * One unclaimed Stakes payout or refund. `win`, `rebate` and `void_refund` are claimed with
 * `claim(roundId, kind, proof)`; `refund` with `claimRefund` (no proof).
 */
export const ClaimItemSchema = z.object({
  roundId: UlidSchema,
  chainRoundId: DecimalBigintSchema,
  kind: PayoutKindSchema,
  account: AddressSchema,
  amount: DecimalBigintSchema,
  proof: z.array(Hex32Schema).nullable(),
  /** When `claim` starts accepting this payout (end of the challenge window). */
  claimsOpenAt: EpochMsSchema.nullable(),
  /** The account the payout belongs to: the caller or an account merged into it; null by wallet. */
  userId: UlidSchema.nullable(),
});
export type ClaimItem = z.infer<typeof ClaimItemSchema>;

/**
 * One of the wallet's own unclaimed payouts or refunds in a room round, listed by `?wallet=` so a
 * deleted account can still claim it ("Identity and personhood" › Account deletion): only what
 * claiming needs, with no round ID, question, room or other members' data.
 */
export const RoomClaimItemSchema = z.object({
  chainRoundId: DecimalBigintSchema,
  kind: PayoutKindSchema,
  account: AddressSchema,
  amount: DecimalBigintSchema,
  proof: z.array(Hex32Schema).nullable(),
  claimsOpenAt: EpochMsSchema.nullable(),
});
export type RoomClaimItem = z.infer<typeof RoomClaimItemSchema>;

/**
 * GET /claims response. `roomClaims` comes with `?wallet=` only (signed in, the caller's room
 * rounds are in `claims` like any other).
 */
export const ClaimsResponseSchema = z.object({
  claims: z.array(ClaimItemSchema),
  roomClaims: z.array(RoomClaimItemSchema).optional(),
});
export type ClaimsResponse = z.infer<typeof ClaimsResponseSchema>;
