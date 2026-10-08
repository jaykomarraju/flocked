// Responsible-play limits (route module `limits`). Spec: "API", "Compliance and responsible play",
// "Data model" (`limits`).

import { z } from 'zod';

import { DecimalBigintSchema, EpochMsSchema } from '../wire';

/** Self-exclusion lengths. Spec: "Compliance and responsible play" (7 days, 30 days, 6 months). */
export const SELF_EXCLUSION_PERIODS = ['7d', '30d', '6m', 'permanent'] as const;
export type SelfExclusionPeriod = (typeof SELF_EXCLUSION_PERIODS)[number];
export const SelfExclusionPeriodSchema = z.enum(SELF_EXCLUSION_PERIODS);

/**
 * The caller's limits, one field per `limits` column. Amounts are USDC base units. `excluded`
 * applies the spec's single exclusion rule: `until` in the future, or permanent and not yet lifted.
 */
export const LimitsStateSchema = z.object({
  /** Null when the user has not set a cap. */
  dailyStakeCap: DecimalBigintSchema.nullable(),
  /** A raised cap waiting out its 24 hours; null when none. */
  pendingCap: DecimalBigintSchema.nullable(),
  pendingCapEffectiveAt: EpochMsSchema.nullable(),
  selfExclusion: z.object({
    startedAt: EpochMsSchema.nullable(),
    until: EpochMsSchema.nullable(),
    permanent: z.boolean(),
    liftRequestedAt: EpochMsSchema.nullable(),
    liftEffectiveAt: EpochMsSchema.nullable(),
  }),
  excluded: z.boolean(),
  /** Question submission block (5 rejections in 7 days). */
  questionBlockUntil: EpochMsSchema.nullable(),
});
export type LimitsState = z.infer<typeof LimitsStateSchema>;

// PUT /me/limits --------------------------------------------------------------------------------

/**
 * PUT /me/limits. Either or both fields. A cap decrease is immediate and an increase waits 24
 * hours. `selfExclusion` starts or lengthens an exclusion; shortening or ending one is rejected
 * with `exclusion_cannot_shorten`.
 */
export const SetLimitsRequestSchema = z
  .strictObject({
    dailyStakeCap: DecimalBigintSchema.optional(),
    selfExclusion: SelfExclusionPeriodSchema.optional(),
  })
  .refine((v) => v.dailyStakeCap !== undefined || v.selfExclusion !== undefined, {
    message: 'set dailyStakeCap, selfExclusion or both',
  });
export type SetLimitsRequest = z.infer<typeof SetLimitsRequestSchema>;
export const SetLimitsResponseSchema = z.object({ limits: LimitsStateSchema });
export type SetLimitsResponse = z.infer<typeof SetLimitsResponseSchema>;

// POST /me/limits/exclusion-lift ----------------------------------------------------------------

/**
 * POST /me/limits/exclusion-lift: no body. Accepted only 6 months into a permanent exclusion;
 * the lift takes effect 7 days later (`limits.selfExclusion.liftEffectiveAt`).
 */
export const ExclusionLiftResponseSchema = z.object({ limits: LimitsStateSchema });
export type ExclusionLiftResponse = z.infer<typeof ExclusionLiftResponseSchema>;
