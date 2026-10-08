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

/** GET /claims response. */
export const ClaimsResponseSchema = z.object({ claims: z.array(ClaimItemSchema) });
export type ClaimsResponse = z.infer<typeof ClaimsResponseSchema>;
