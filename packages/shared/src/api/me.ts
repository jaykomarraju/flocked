// The signed-in user's account (route module `me`). Spec: "API", "Identity and personhood",
// "Data model" (`users`, `identities`, `merges`, `referrals`, `notification_prefs`).

import { z } from 'zod';

import {
  AddressSchema,
  DecimalBigintSchema,
  EmailSchema,
  EpochMsSchema,
  HandleSchema,
  HexBytesSchema,
  HttpUrlSchema,
  NotificationEventSchema,
  ProviderSchema,
  RefCodeSchema,
  UlidSchema,
  UserRoleSchema,
  UserStatusSchema,
} from '../wire';
import { ApiOkResponseSchema, EmailCodeSchema } from './auth';
import { LimitsStateSchema } from './limits';

// Shared views ----------------------------------------------------------------------------------

/** `notification_prefs.channel`. Spec: "Data model". */
export const NOTIFICATION_CHANNELS = ['farcaster', 'webpush', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

/** One `notification_prefs` row. */
export const NotificationPrefSchema = z.object({
  channel: NotificationChannelSchema,
  event: NotificationEventSchema,
  enabled: z.boolean(),
});
export type NotificationPref = z.infer<typeof NotificationPrefSchema>;

/** `users.prefs_json`: card and profile privacy and the creator payout wallet. */
export const UserPrefsSchema = z.object({
  showCardAmounts: z.boolean(),
  showStakesNet: z.boolean(),
  creatorPayoutWallet: AddressSchema.nullable(),
});
export type UserPrefs = z.infer<typeof UserPrefsSchema>;

/**
 * A linked identity. `externalId` is the lowercase address (wallet), FID (farcaster) or address
 * (email); it is null for coinbase, whose external ID is the person ID and never leaves the API.
 */
export const IdentitySchema = z.object({
  id: UlidSchema,
  provider: ProviderSchema,
  externalId: z.string().min(1).nullable(),
  verifiedAt: EpochMsSchema.nullable(),
});
export type Identity = z.infer<typeof IdentitySchema>;

/** `merges.status`. Spec: "Data model". */
export const MERGE_STATUSES = ['pending', 'confirmed', 'refused', 'expired'] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];

/** A pending or past merge. The kept account is the one created first. */
export const MergeSchema = z.object({
  id: UlidSchema,
  status: z.enum(MERGE_STATUSES),
  keptUserId: UlidSchema,
  losingUserId: UlidSchema,
  /** The provider of the identity whose link created the merge. */
  provider: ProviderSchema,
  /** The other account's handle, if it has one. */
  otherHandle: HandleSchema.nullable(),
  createdAt: EpochMsSchema,
  expiresAt: EpochMsSchema,
  confirmedAt: EpochMsSchema.nullable(),
});
export type Merge = z.infer<typeof MergeSchema>;

/** The result of proving control of an identity: linked, or a pending merge. */
export const LinkResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('linked'), identity: IdentitySchema }),
  z.object({ status: z.literal('merge_pending'), merge: MergeSchema }),
]);
export type LinkResult = z.infer<typeof LinkResultSchema>;

/** Proof of a wallet: a SIWE message and its signature (ECDSA, ERC-1271 or ERC-6492). */
export const WalletProofSchema = z.strictObject({
  provider: z.literal('wallet'),
  message: z.string().min(1).max(4096),
  signature: HexBytesSchema,
});
/** Proof of a Farcaster account: a Quick Auth token. */
export const FarcasterProofSchema = z.strictObject({
  provider: z.literal('farcaster'),
  token: z.string().min(1).max(8192),
});
/** Proof of a verified email: a code sent by `POST /auth/email/start` or `POST /me/email`. */
export const EmailProofSchema = z.strictObject({
  provider: z.literal('email'),
  email: EmailSchema,
  code: EmailCodeSchema,
});

/** Why Stakes is unavailable to the caller. Spec: "Compliance and responsible play". */
export const STAKES_INELIGIBILITY_REASONS = [
  'not_verified',
  'geo_blocked',
  'age_unattested',
  'tos_not_accepted',
  'self_excluded',
  'suspended',
  'stakes_disabled',
] as const;
export type StakesIneligibilityReason = (typeof STAKES_INELIGIBILITY_REASONS)[number];

/** ToS and age attestation state. */
export const TosStateSchema = z.object({
  currentVersion: z.string().min(1),
  acceptedVersion: z.string().min(1).nullable(),
  acceptedAt: EpochMsSchema.nullable(),
  ageAttestedAt: EpochMsSchema.nullable(),
});
export type TosState = z.infer<typeof TosStateSchema>;

// GET /me ---------------------------------------------------------------------------------------

/** GET /me: profile, balances, limits, flags, verification status and Stakes eligibility. */
export const MeResponseSchema = z.object({
  user: z.object({
    id: UlidSchema,
    handle: HandleSchema.nullable(),
    displayName: z.string().nullable(),
    avatarUrl: HttpUrlSchema.nullable(),
    role: UserRoleSchema,
    status: UserStatusSchema,
    refCode: RefCodeSchema,
    createdAt: EpochMsSchema,
  }),
  prefs: UserPrefsSchema,
  notificationPrefs: z.array(NotificationPrefSchema),
  identities: z.array(IdentitySchema),
  merges: z.array(MergeSchema),
  /** Points balances: `global`, and one per room the user belongs to. */
  balances: z.object({
    global: DecimalBigintSchema,
    rooms: z.array(z.object({ roomId: UlidSchema, balance: DecimalBigintSchema })),
  }),
  limits: LimitsStateSchema,
  /** Feature flags that affect this user's UI. */
  flags: z.record(z.string(), z.boolean()),
  tos: TosStateSchema,
  verification: z.object({
    personVerified: z.boolean(),
    verifiedAt: EpochMsSchema.nullable(),
    /** Coinbase verified country (ISO 3166-1 alpha-2), when verified. */
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
  }),
  stakes: z.object({
    eligible: z.boolean(),
    /** Empty when eligible. */
    reasons: z.array(z.enum(STAKES_INELIGIBILITY_REASONS)),
  }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// PATCH /me -------------------------------------------------------------------------------------

/** PATCH /me: any subset; `notificationPrefs` rows are upserted. */
export const UpdateMeRequestSchema = z
  .strictObject({
    handle: HandleSchema.optional(),
    displayName: z.string().min(1).max(40).nullable().optional(),
    notificationPrefs: z.array(NotificationPrefSchema.strict()).max(64).optional(),
    prefs: z
      .strictObject({
        showCardAmounts: z.boolean().optional(),
        showStakesNet: z.boolean().optional(),
        creatorPayoutWallet: AddressSchema.nullable().optional(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty update' });
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;
export const UpdateMeResponseSchema = MeResponseSchema;
export type UpdateMeResponse = MeResponse;

// POST /me/tos ----------------------------------------------------------------------------------

/** POST /me/tos: accept the current ToS version and attest the age requirement. */
export const AcceptTosRequestSchema = z.strictObject({
  tosVersion: z.string().min(1).max(64),
  ageAttested: z.literal(true),
});
export type AcceptTosRequest = z.infer<typeof AcceptTosRequestSchema>;
export const AcceptTosResponseSchema = z.object({ tos: TosStateSchema });
export type AcceptTosResponse = z.infer<typeof AcceptTosResponseSchema>;

// POST /me/identities/link ----------------------------------------------------------------------

/**
 * POST /me/identities/link: link a wallet (SIWE) or a Farcaster account. Emails are linked with
 * `POST /me/email` + `POST /me/email/verify`; Coinbase with `POST /me/personhood`.
 */
export const LinkIdentityRequestSchema = z.discriminatedUnion('provider', [
  WalletProofSchema,
  FarcasterProofSchema,
]);
export type LinkIdentityRequest = z.infer<typeof LinkIdentityRequestSchema>;
export const LinkIdentityResponseSchema = LinkResultSchema;
export type LinkIdentityResponse = LinkResult;

// POST /me/merges/:id/confirm -------------------------------------------------------------------

/**
 * POST /me/merges/:id/confirm: confirm by signing in to the other account with one of its own
 * sign-in identities.
 */
export const ConfirmMergeRequestSchema = z.discriminatedUnion('provider', [
  WalletProofSchema,
  FarcasterProofSchema,
  EmailProofSchema,
]);
export type ConfirmMergeRequest = z.infer<typeof ConfirmMergeRequestSchema>;
export const ConfirmMergeResponseSchema = z.object({ merge: MergeSchema });
export type ConfirmMergeResponse = z.infer<typeof ConfirmMergeResponseSchema>;

// DELETE /me/identities/:id ---------------------------------------------------------------------

/** DELETE /me/identities/:id: no body; returns the remaining identities. */
export const UnlinkIdentityResponseSchema = z.object({ identities: z.array(IdentitySchema) });
export type UnlinkIdentityResponse = z.infer<typeof UnlinkIdentityResponseSchema>;

// POST /me/email --------------------------------------------------------------------------------

/** POST /me/email: add an address and send it a verification code. */
export const AddEmailRequestSchema = z.strictObject({ email: EmailSchema });
export type AddEmailRequest = z.infer<typeof AddEmailRequestSchema>;
export const AddEmailResponseSchema = z.object({
  email: EmailSchema,
  codeExpiresAt: EpochMsSchema,
});
export type AddEmailResponse = z.infer<typeof AddEmailResponseSchema>;

// POST /me/email/verify -------------------------------------------------------------------------

/** POST /me/email/verify: links the email, or creates a pending merge if another account has it. */
export const VerifyEmailRequestSchema = z.strictObject({
  email: EmailSchema,
  code: EmailCodeSchema,
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;
export const VerifyEmailResponseSchema = LinkResultSchema;
export type VerifyEmailResponse = LinkResult;

// POST /me/personhood ---------------------------------------------------------------------------

/** POST /me/personhood: no body; returns the Coinbase authorize URL. */
export const StartPersonhoodResponseSchema = z.object({ authorizeUrl: HttpUrlSchema });
export type StartPersonhoodResponse = z.infer<typeof StartPersonhoodResponseSchema>;

// GET /me/personhood/callback -------------------------------------------------------------------

/** GET /me/personhood/callback query: the OAuth redirect parameters. */
export const PersonhoodCallbackQuerySchema = z.object({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(2048).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(1024).optional(),
});
export type PersonhoodCallbackQuery = z.infer<typeof PersonhoodCallbackQuerySchema>;

/**
 * GET /me/personhood/callback outcome. Authenticated by the single-use state, not a session.
 * The route finishes with a redirect to the app; this is the outcome it reports. It never
 * merges: a person ID bound to another account yields a pending merge.
 */
export const PersonhoodCallbackResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('verified'),
    verifiedAt: EpochMsSchema,
    country: z.string().regex(/^[A-Z]{2}$/),
  }),
  z.object({ status: z.literal('merge_pending'), merge: MergeSchema }),
  z.object({ status: z.literal('failed'), reason: z.string() }),
]);
export type PersonhoodCallbackResponse = z.infer<typeof PersonhoodCallbackResponseSchema>;

// GET /me/referrals -----------------------------------------------------------------------------

/** `referrals.status`. Spec: "Data model". */
export const REFERRAL_STATUSES = ['pending', 'qualified', 'rewarded'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** GET /me/referrals: the caller's code, invitees and total points earned. */
export const ReferralsResponseSchema = z.object({
  refCode: RefCodeSchema,
  referrals: z.array(
    z.object({
      status: z.enum(REFERRAL_STATUSES),
      refereeHandle: HandleSchema.nullable(),
      qualifiedRoundId: UlidSchema.nullable(),
      createdAt: EpochMsSchema,
      rewardedAt: EpochMsSchema.nullable(),
    }),
  ),
  rewardTotal: DecimalBigintSchema,
});
export type ReferralsResponse = z.infer<typeof ReferralsResponseSchema>;

// DELETE /me ------------------------------------------------------------------------------------

/**
 * DELETE /me: no body. Refused with `deletion_blocked` while a round is not final, and with
 * `self_excluded` / `account_suspended` during an exclusion or suspension.
 */
export const DeleteMeResponseSchema = ApiOkResponseSchema;
export type DeleteMeResponse = z.infer<typeof DeleteMeResponseSchema>;
