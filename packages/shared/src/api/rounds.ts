// Rounds (route module `rounds`). Spec: "API", "Round lifecycle", "Settlement and payout math",
// "Real-time and the reveal", "Data model" (`rounds`, `round_modes`, `settlements`).
//
// Reveal gating: nothing here carries per-option data for a mode until that mode's `revealedAt`
// is set. `RoundModeViewSchema` enforces it.

import { z } from 'zod';

import {
  AddressSchema,
  BeaconRoundSchema,
  BpsSchema,
  CategorySchema,
  CountSchema,
  DecimalBigintSchema,
  EpochMsSchema,
  GameDaySchema,
  HandleSchema,
  Hex32Schema,
  LimitQuerySchema,
  ModeStatusSchema,
  OptionIndexSchema,
  RefundReasonCodeSchema,
  RoundKindSchema,
  RoundStatusSchema,
  UlidSchema,
  UnixSecondsSchema,
} from '../wire';
import { PublicUserSchema } from './auth';
import { QuestionOptionSchema } from './questions';

/** `{ free?: T, stakes?: T }`: one value per mode that the round has (mirrors RoundDO storage). */
export function perModeSchema<T extends z.ZodType>(schema: T) {
  return z.object({ free: schema.optional(), stakes: schema.optional() });
}

// Locked config ---------------------------------------------------------------------------------

/**
 * Free mode's locked config: the `FreeLockedConfig` fields of `config_json` (./config) plus the
 * config hash. Free runs the formula with `feeBps` = `creatorBps` = 0.
 */
export const FreeConfigWireSchema = z.object({
  stakeMin: DecimalBigintSchema,
  stakeMax: DecimalBigintSchema,
  /** Stake selector presets, ascending, within the range. */
  presets: z.array(DecimalBigintSchema),
  feeBps: BpsSchema,
  creatorBps: BpsSchema,
  capMultiple: z.int().min(1).max(255),
  minEntrants: z.int().min(1),
  creatorAwardBps: BpsSchema,
  /** The creator-award recipient (user ID); null for house questions and room rounds. */
  awardRecipient: UlidSchema.nullable(),
  /** keccak256 of the Free config's canonical JSON (committed by the lock leaf). */
  configHash: Hex32Schema,
});
export type FreeConfigWire = z.infer<typeof FreeConfigWireSchema>;

/**
 * Stakes mode's locked config: every `RoundConfig` field as created onchain (times in seconds),
 * plus the chain round ID, the author's handle and payout address. Clients compare each field
 * with the onchain record before building `enter`. Addresses are lowercase here even where
 * `config_json` stores them checksummed.
 */
export const StakesConfigWireSchema = z.object({
  chainRoundId: DecimalBigintSchema,
  opensAt: UnixSecondsSchema,
  closesAt: UnixSecondsSchema,
  beaconRound: BeaconRoundSchema,
  stake: DecimalBigintSchema,
  feeBps: BpsSchema,
  creatorBps: BpsSchema,
  capMultiple: z.int().min(1).max(255),
  minEntrants: z.int().min(1),
  /** `RoundConfig.creator`: the author's payout address, or the treasury. */
  creator: AddressSchema,
  questionHash: Hex32Schema,
  /** Null for house questions. */
  authorHandle: HandleSchema.nullable(),
  /** The author's payout wallet; null when there is none (then `creator` is the treasury). */
  payoutAddress: AddressSchema.nullable(),
});
export type StakesConfigWire = z.infer<typeof StakesConfigWireSchema>;

/** A config value that differs from the launch default, with the audit-log row that set it. */
export const ConfigOverrideSchema = z.object({
  /** Dotted path, e.g. `stakes.minEntrants`. */
  field: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  auditId: z.string().min(1),
});
export type ConfigOverride = z.infer<typeof ConfigOverrideSchema>;

/** The config frozen at question lock (`rounds.config_json`), as published. */
export const RoundConfigWireSchema = z.object({
  /** Seconds from close to the beacon (60..600). */
  beaconDelay: z.int().min(60).max(600),
  free: FreeConfigWireSchema.optional(),
  stakes: StakesConfigWireSchema.optional(),
  overrides: z.array(ConfigOverrideSchema),
});
export type RoundConfigWire = z.infer<typeof RoundConfigWireSchema>;

// Results ---------------------------------------------------------------------------------------

/** One option's revealed totals: headcount and total stake. */
export const OptionTallySchema = z.object({
  headcount: CountSchema,
  total: DecimalBigintSchema,
});
export type OptionTally = z.infer<typeof OptionTallySchema>;

/** Per-option tallies, option 0 then option 1. */
export const TallySchema = z.tuple([OptionTallySchema, OptionTallySchema]);

/** `settlements.outcome`. */
export const SETTLEMENT_OUTCOMES = ['settled', 'refunded', 'voided'] as const;
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];

/** The current settlement record for a mode (`settlements` row not superseded). */
export const SettlementViewSchema = z.object({
  proposalSeq: CountSchema,
  outcome: z.enum(SETTLEMENT_OUTCOMES),
  formulaVersion: z.int().min(1),
  /** Null when refunded or voided. */
  winningOption: OptionIndexSchema.nullable(),
  tally: TallySchema,
  lossPool: DecimalBigintSchema,
  fee: DecimalBigintSchema,
  creatorFee: DecimalBigintSchema,
  distributable: DecimalBigintSchema,
  rebatePool: DecimalBigintSchema,
  dust: DecimalBigintSchema,
  payoutRoot: Hex32Schema.nullable(),
  bundleHash: Hex32Schema.nullable(),
  /** Stakes proposal transaction. */
  txHash: Hex32Schema.nullable(),
  settledAt: EpochMsSchema,
});
export type SettlementView = z.infer<typeof SettlementViewSchema>;

/** One mode of a round, as served. `settlement` stays null until `revealedAt` is set. */
export const RoundModeViewSchema = z
  .object({
    status: ModeStatusSchema,
    entrantCount: CountSchema,
    pool: DecimalBigintSchema,
    /** Stakes only. */
    chainRoundId: DecimalBigintSchema.nullable(),
    revealedAt: EpochMsSchema.nullable(),
    /** Stakes only, from the onchain proposal. */
    claimsOpenAt: EpochMsSchema.nullable(),
    finalAt: EpochMsSchema.nullable(),
    refundReason: RefundReasonCodeSchema.nullable(),
    settlement: SettlementViewSchema.nullable(),
  })
  .refine((m) => m.settlement === null || m.revealedAt !== null, {
    message: 'per-option data before reveal',
    path: ['settlement'],
  });
export type RoundModeView = z.infer<typeof RoundModeViewSchema>;

// Round views -----------------------------------------------------------------------------------

/** The question as shown on a round. */
export const RoundQuestionSchema = z.object({
  id: UlidSchema,
  prompt: z.string().min(1),
  options: z.tuple([QuestionOptionSchema, QuestionOptionSchema]),
  category: CategorySchema,
  /** Null for house questions. */
  author: PublicUserSchema.nullable(),
});
export type RoundQuestion = z.infer<typeof RoundQuestionSchema>;

/**
 * A round. `opensAt`, `closesAt` and `beaconTime` are Unix SECONDS (beacon math); `lockedAt` and
 * every per-mode time are epoch ms.
 */
export const RoundViewSchema = z.object({
  id: UlidSchema,
  kind: RoundKindSchema,
  roomId: UlidSchema.nullable(),
  gameDay: GameDaySchema,
  status: RoundStatusSchema,
  question: RoundQuestionSchema,
  opensAt: UnixSecondsSchema,
  closesAt: UnixSecondsSchema,
  beaconRound: BeaconRoundSchema,
  beaconTime: UnixSecondsSchema,
  lockedAt: EpochMsSchema.nullable(),
  /** Null before question lock. */
  config: RoundConfigWireSchema.nullable(),
  modes: perModeSchema(RoundModeViewSchema),
});
export type RoundView = z.infer<typeof RoundViewSchema>;

// GET /rounds/today -----------------------------------------------------------------------------

/**
 * GET /rounds/today: the open daily round (null in a schedule gap) and, while it is still
 * revealing or settling, the previous daily round's ID.
 */
export const RoundsTodayResponseSchema = z.object({
  round: RoundViewSchema.nullable(),
  previousRoundId: UlidSchema.nullable(),
});
export type RoundsTodayResponse = z.infer<typeof RoundsTodayResponseSchema>;

// GET /rounds/:id -------------------------------------------------------------------------------

/** GET /rounds/:id: the round with per-mode settlement once that mode has revealed. */
export const RoundDetailResponseSchema = z.object({ round: RoundViewSchema });
export type RoundDetailResponse = z.infer<typeof RoundDetailResponseSchema>;

// GET /rounds?before=&limit= --------------------------------------------------------------------

/** GET /rounds query: daily rounds whose game day is before `before` (exclusive), newest first. */
export const RoundsArchiveQuerySchema = z.object({
  before: GameDaySchema.optional(),
  limit: LimitQuerySchema.optional(),
});
export type RoundsArchiveQuery = z.infer<typeof RoundsArchiveQuerySchema>;

/** One archived round: question and per-mode outcome. */
export const RoundArchiveItemSchema = z.object({
  id: UlidSchema,
  gameDay: GameDaySchema,
  question: RoundQuestionSchema,
  modes: perModeSchema(
    z.object({
      status: ModeStatusSchema,
      entrantCount: CountSchema,
      pool: DecimalBigintSchema,
      winningOption: OptionIndexSchema.nullable(),
      tally: TallySchema.nullable(),
      refundReason: RefundReasonCodeSchema.nullable(),
    }),
  ),
});
export type RoundArchiveItem = z.infer<typeof RoundArchiveItemSchema>;

/** GET /rounds response. `nextBefore` is the cursor for the next page, or null at the end. */
export const RoundsArchiveResponseSchema = z.object({
  rounds: z.array(RoundArchiveItemSchema),
  nextBefore: GameDaySchema.nullable(),
});
export type RoundsArchiveResponse = z.infer<typeof RoundsArchiveResponseSchema>;

// GET /rounds/:id/verify ------------------------------------------------------------------------

/**
 * One mode's public verification bundle. Clients fetch `manifestUrl` and check
 * keccak256(manifest bytes) = `bundleHash`; chunk hashes are in the manifest. URLs may be
 * absolute or relative to the API origin.
 */
export const VerifyBundleSchema = z.object({
  bundleHash: Hex32Schema,
  manifestUrl: z.string().min(1),
  chunkUrls: z.array(z.string().min(1)),
  /** Free: the lock leaf anchor transaction. */
  lockTx: Hex32Schema.nullable(),
  /** Free: the commitment root and its anchor transaction. */
  commitmentRoot: Hex32Schema.nullable(),
  commitTx: Hex32Schema.nullable(),
  /** Free: the manifest anchor; Stakes: the proposal carrying `bundleHash`. */
  anchorTx: Hex32Schema.nullable(),
});
export type VerifyBundle = z.infer<typeof VerifyBundleSchema>;

/** GET /rounds/:id/verify: a bundle for each mode that has one (after its reveal or refund). */
export const RoundVerifyResponseSchema = z.object({
  roundId: UlidSchema,
  modes: perModeSchema(VerifyBundleSchema),
});
export type RoundVerifyResponse = z.infer<typeof RoundVerifyResponseSchema>;
