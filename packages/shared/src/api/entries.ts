// Entries. Route modules `entries` (Free entry, the caller's entries), `stakes` (entry tickets)
// and `paymaster` (the ERC-7677 proxy, plan wave 10 "Paymaster proxy"; not in the spec's API
// table). Spec: "API", "Sealed picks (timelock encryption)", "Real-time and the reveal",
// "Smart contract", "Data model" (`entries`, `payouts`, `stakes_tickets`).

import { z } from 'zod';

import {
  AddressSchema,
  BeaconRoundSchema,
  CiphertextSchema,
  CountSchema,
  DecimalBigintSchema,
  EcdsaSignatureSchema,
  EpochMsSchema,
  Hex32Schema,
  ModeSchema,
  ModeStatusSchema,
  OptionIndexSchema,
  PayoutKindSchema,
  ShareIdSchema,
  TurnstileTokenSchema,
  UlidSchema,
  UnixSecondsSchema,
  VoidReasonSchema,
} from '../wire';
import { perModeSchema } from './rounds';

/** An EVM chain ID. */
export const ChainIdSchema = z.int().min(1);

/**
 * A signed Free receipt, field for field the EIP-712 `Receipt(bytes16 roundId, uint8 mode,
 * bytes32 userIdHash, uint64 stake, bytes32 commitment, uint32 seq, uint64 closesAt,
 * uint64 beaconRound)` on `FlockedAnchor` (plan P2.2), plus the domain and signer needed to
 * verify it. `roundId` is the ULID (bytes16 on chain); `closesAt` is seconds.
 */
export const FreeReceiptWireSchema = z.object({
  roundId: UlidSchema,
  mode: z.literal('free'),
  userIdHash: Hex32Schema,
  stake: DecimalBigintSchema,
  commitment: Hex32Schema,
  seq: CountSchema,
  closesAt: UnixSecondsSchema,
  beaconRound: BeaconRoundSchema,
  signature: EcdsaSignatureSchema,
  signer: AddressSchema,
  chainId: ChainIdSchema,
  verifyingContract: AddressSchema,
});
export type FreeReceiptWire = z.infer<typeof FreeReceiptWireSchema>;

// POST /rounds/:id/entries ----------------------------------------------------------------------

/**
 * POST /rounds/:id/entries: a Free entry. `stake` is points; `ciphertext` is the binary age file
 * in base64url. `turnstileToken` is required on the first Free entry of each game day. Stakes
 * entries are onchain and rejected here with `stakes_entry_onchain`.
 */
export const CreateEntryRequestSchema = z.strictObject({
  stake: DecimalBigintSchema,
  ciphertext: CiphertextSchema,
  turnstileToken: TurnstileTokenSchema.optional(),
});
export type CreateEntryRequest = z.infer<typeof CreateEntryRequestSchema>;

/** POST /rounds/:id/entries response: the committed entry and its signed receipt. */
export const CreateEntryResponseSchema = z.object({
  entry: z.object({
    id: UlidSchema,
    roundId: UlidSchema,
    mode: z.literal('free'),
    stake: DecimalBigintSchema,
    commitment: Hex32Schema,
    createdAt: EpochMsSchema,
  }),
  receipt: FreeReceiptWireSchema,
});
export type CreateEntryResponse = z.infer<typeof CreateEntryResponseSchema>;

// POST /rounds/:id/entries/stakes/prepare (module `stakes`) -------------------------------------

/** POST /rounds/:id/entries/stakes/prepare: the wallet that will call `enter`. */
export const StakesPrepareRequestSchema = z.strictObject({ wallet: AddressSchema });
export type StakesPrepareRequest = z.infer<typeof StakesPrepareRequestSchema>;

/**
 * An entry ticket, field for field the EIP-712 `EntryTicket(uint256 roundId, address wallet,
 * bytes32 personTag, uint64 expiry)` on `FlockedEscrow` (plan P1.3). `roundId` is the chain
 * round ID; `expiry` is seconds (compared with `block.timestamp`).
 */
export const StakesTicketWireSchema = z.object({
  roundId: DecimalBigintSchema,
  wallet: AddressSchema,
  personTag: Hex32Schema,
  expiry: UnixSecondsSchema,
});
export type StakesTicketWire = z.infer<typeof StakesTicketWireSchema>;

/** POST /rounds/:id/entries/stakes/prepare response: the signed ticket and what `enter` needs. */
export const StakesPrepareResponseSchema = z.object({
  ticket: StakesTicketWireSchema,
  signature: EcdsaSignatureSchema,
  chainId: ChainIdSchema,
  /** The `FlockedEscrow` address. */
  verifyingContract: AddressSchema,
  /** The round's fixed stake (USDC base units), for the `approve` call. */
  stake: DecimalBigintSchema,
  beaconRound: BeaconRoundSchema,
});
export type StakesPrepareResponse = z.infer<typeof StakesPrepareResponseSchema>;

// GET /rounds/:id/me ----------------------------------------------------------------------------

/** The caller's result in one mode. */
export const ENTRY_RESULTS = ['win', 'loss', 'refund', 'void'] as const;
export type EntryResult = (typeof ENTRY_RESULTS)[number];

/** One payout to the caller (`payouts` row), with its claim proof for Stakes. */
export const MyPayoutSchema = z.object({
  kind: PayoutKindSchema,
  amount: DecimalBigintSchema,
  /** Stakes: the claiming wallet. */
  wallet: AddressSchema.nullable(),
  /** Stakes payout-tree proof (`claim`); null for Free and for `claimRefund`. */
  proof: z.array(Hex32Schema).nullable(),
  claimedAt: EpochMsSchema.nullable(),
  claimTx: Hex32Schema.nullable(),
});
export type MyPayout = z.infer<typeof MyPayoutSchema>;

/** The caller's entry in one mode. Option, validity and result stay null until the reveal. */
export const MyModeEntrySchema = z.object({
  modeStatus: ModeStatusSchema,
  entry: z.object({
    id: UlidSchema,
    stake: DecimalBigintSchema,
    commitment: Hex32Schema,
    createdAt: EpochMsSchema,
    /** Stakes only. */
    wallet: AddressSchema.nullable(),
    txHash: Hex32Schema.nullable(),
    blockNumber: CountSchema.nullable(),
    logIndex: CountSchema.nullable(),
    optionIndex: OptionIndexSchema.nullable(),
    valid: z.boolean().nullable(),
    voidReason: VoidReasonSchema.nullable(),
  }),
  /** Free only. */
  receipt: FreeReceiptWireSchema.nullable(),
  /** Free: Merkle proof of the receipt leaf in the anchored commitment root, once built. */
  inclusionProof: z.array(Hex32Schema).nullable(),
  result: z.enum(ENTRY_RESULTS).nullable(),
  payouts: z.array(MyPayoutSchema),
  /** Stakes only. */
  claimsOpenAt: EpochMsSchema.nullable(),
});
export type MyModeEntry = z.infer<typeof MyModeEntrySchema>;

/** GET /rounds/:id/me: the caller's entries per mode and their share cards. */
export const RoundMeResponseSchema = z.object({
  roundId: UlidSchema,
  modes: perModeSchema(MyModeEntrySchema),
  cards: z.array(
    z.object({ kind: z.enum(['result', 'teaser']), mode: ModeSchema, shareId: ShareIdSchema }),
  ),
});
export type RoundMeResponse = z.infer<typeof RoundMeResponseSchema>;

// POST /paymaster (module `paymaster`; plan wave 10, not in the spec's API table) ---------------

/**
 * Hex as other wallets send it (any case). The paymaster speaks ERC-7677 to third-party wallet
 * code, so it does not impose the lowercase wire rule.
 */
const LooseHexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const JsonRpcIdSchema = z.union([z.string(), z.int()]);

export const PAYMASTER_METHODS = ['pm_getPaymasterStubData', 'pm_getPaymasterData'] as const;

/**
 * POST /paymaster: an ERC-7677 JSON-RPC request. `params` is `[userOperation, entryPoint,
 * chainId, context]`; the user operation is checked against the spec's allow list by the route.
 */
export const PaymasterRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  method: z.enum(PAYMASTER_METHODS),
  params: z.tuple([
    z.record(z.string(), z.unknown()),
    LooseHexSchema.length(42),
    LooseHexSchema,
    z.record(z.string(), z.unknown()).nullable(),
  ]),
});
export type PaymasterRequest = z.infer<typeof PaymasterRequestSchema>;

/** POST /paymaster response: a JSON-RPC result (stub or final paymaster fields) or error. */
export const PaymasterResponseSchema = z.union([
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    result: z.looseObject({
      paymaster: LooseHexSchema.optional(),
      paymasterData: LooseHexSchema.optional(),
      paymasterAndData: LooseHexSchema.optional(),
      paymasterVerificationGasLimit: LooseHexSchema.optional(),
      paymasterPostOpGasLimit: LooseHexSchema.optional(),
      sponsor: z.object({ name: z.string(), icon: z.string().optional() }).optional(),
      isFinal: z.boolean().optional(),
    }),
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema.nullable(),
    error: z.object({ code: z.int(), message: z.string(), data: z.unknown().optional() }),
  }),
]);
export type PaymasterResponse = z.infer<typeof PaymasterResponseSchema>;
