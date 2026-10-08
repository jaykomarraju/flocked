// Sign-in endpoints (route module `auth`). Spec: "API", "Identity and personhood".

import { z } from 'zod';

import {
  EmailSchema,
  EpochMsSchema,
  HandleSchema,
  HexBytesSchema,
  HttpUrlSchema,
  RefCodeSchema,
  TurnstileTokenSchema,
  UlidSchema,
  UserRoleSchema,
} from '../wire';

/** `{ ok: true }`, for writes with nothing else to return. */
export const ApiOkResponseSchema = z.object({ ok: z.literal(true) });
export type ApiOkResponse = z.infer<typeof ApiOkResponseSchema>;

/** How the new session is carried: an HttpOnly cookie (web) or a Bearer token (mini app). */
export const SESSION_TRANSPORTS = ['cookie', 'bearer'] as const;
export type SessionTransport = (typeof SESSION_TRANSPORTS)[number];
export const SessionTransportSchema = z.enum(SESSION_TRANSPORTS);

/** A user as other players see them (boards, rooms, question authors, profiles). */
export const PublicUserSchema = z.object({
  id: UlidSchema,
  handle: HandleSchema.nullable(),
  displayName: z.string().nullable(),
  avatarUrl: HttpUrlSchema.nullable(),
});
export type PublicUser = z.infer<typeof PublicUserSchema>;

/** The signed-in user as returned by sign-in endpoints. */
export const SessionUserSchema = z.object({
  id: UlidSchema,
  /** Null until the user picks one (new wallet accounts). */
  handle: HandleSchema.nullable(),
  displayName: z.string().nullable(),
  avatarUrl: HttpUrlSchema.nullable(),
  role: UserRoleSchema,
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

/**
 * A new session. `created` is true when this call created the account. `token` is the Bearer
 * token when `transport` was `bearer`, else null (the cookie is set on the response).
 */
export const AuthSessionResponseSchema = z.object({
  user: SessionUserSchema,
  created: z.boolean(),
  token: z.string().min(1).nullable(),
  expiresAt: EpochMsSchema,
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

/** Fields every account-creating sign-in accepts. */
const signupFields = {
  /** Required by the server when the call would create an account (spec "Anti-abuse"). */
  turnstileToken: TurnstileTokenSchema.optional(),
  /** Referral attribution carried into signup (spec "Share cards and distribution"). */
  ref: RefCodeSchema.optional(),
  /** Defaults to `cookie` for SIWE and email, `bearer` for Farcaster. */
  transport: SessionTransportSchema.optional(),
};

// POST /auth/siwe/nonce -------------------------------------------------------------------------

/** POST /auth/siwe/nonce: no body. */
export const SiweNonceResponseSchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
  expiresAt: EpochMsSchema,
});
export type SiweNonceResponse = z.infer<typeof SiweNonceResponseSchema>;

// POST /auth/siwe/verify ------------------------------------------------------------------------

/**
 * POST /auth/siwe/verify. `signature` is any length: smart wallets return ERC-1271/ERC-6492
 * signatures, not 65-byte ECDSA.
 */
export const SiweVerifyRequestSchema = z.strictObject({
  message: z.string().min(1).max(4096),
  signature: HexBytesSchema,
  ...signupFields,
});
export type SiweVerifyRequest = z.infer<typeof SiweVerifyRequestSchema>;
export const SiweVerifyResponseSchema = AuthSessionResponseSchema;
export type SiweVerifyResponse = AuthSessionResponse;

// POST /auth/farcaster --------------------------------------------------------------------------

/** POST /auth/farcaster: exchange a Farcaster Quick Auth token for a session. */
export const FarcasterAuthRequestSchema = z.strictObject({
  token: z.string().min(1).max(8192),
  ...signupFields,
});
export type FarcasterAuthRequest = z.infer<typeof FarcasterAuthRequestSchema>;
export const FarcasterAuthResponseSchema = AuthSessionResponseSchema;
export type FarcasterAuthResponse = AuthSessionResponse;

// POST /auth/email/start ------------------------------------------------------------------------

/**
 * POST /auth/email/start. Answers `{ ok: true }` whether or not the address is linked, so it
 * cannot be used to probe for accounts. Email cannot create an account.
 */
export const EmailStartRequestSchema = z.strictObject({
  email: EmailSchema,
  turnstileToken: TurnstileTokenSchema.optional(),
});
export type EmailStartRequest = z.infer<typeof EmailStartRequestSchema>;
export const EmailStartResponseSchema = ApiOkResponseSchema;
export type EmailStartResponse = ApiOkResponse;

// POST /auth/email/verify -----------------------------------------------------------------------

/** An 8-digit email code (spec "API", rate limits). */
export const EmailCodeSchema = z.string().regex(/^\d{8}$/, 'expected an 8-digit code');

/** POST /auth/email/verify. */
export const EmailVerifyRequestSchema = z.strictObject({
  email: EmailSchema,
  code: EmailCodeSchema,
  transport: SessionTransportSchema.optional(),
});
export type EmailVerifyRequest = z.infer<typeof EmailVerifyRequestSchema>;
export const EmailVerifyResponseSchema = AuthSessionResponseSchema;
export type EmailVerifyResponse = AuthSessionResponse;

// POST /auth/logout -----------------------------------------------------------------------------

/** POST /auth/logout: no body. */
export const LogoutResponseSchema = ApiOkResponseSchema;
export type LogoutResponse = ApiOkResponse;
