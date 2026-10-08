// The REST error envelope. Spec: "API" ("errors are returned as {error: {code, message}}").

import { z } from 'zod';

/**
 * Every error code the API returns, grouped by area. The generic codes come first; the rest are
 * the rejections the spec names in "API", "Identity and personhood", "Real-time and the reveal"
 * (Free entry checks), "Compliance and responsible play" and "Anti-abuse".
 */
export const ERROR_CODES = [
  // Generic
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'gone',
  'payload_too_large',
  'rate_limited',
  'internal',
  'not_implemented',
  'unavailable',
  // Sign-in and sessions
  'turnstile_failed',
  'invalid_signature',
  'invalid_nonce',
  'invalid_token',
  'invalid_code',
  'code_expired',
  'too_many_attempts',
  'session_expired',
  'account_suspended',
  'account_deleted',
  'tos_required',
  // Identities and merges
  'identity_unverified',
  'identity_required',
  'identity_locked',
  'merge_blocked',
  'merge_expired',
  'handle_taken',
  'deletion_blocked',
  // Entries
  'round_not_open',
  'round_closed',
  'mode_unavailable',
  'already_entered',
  'stakes_entry_onchain',
  'stake_out_of_range',
  'insufficient_balance',
  'invalid_ciphertext',
  'self_excluded',
  'not_member',
  // Stakes tickets
  'not_verified',
  'ineligible',
  'stakes_disabled',
  'stake_cap_reached',
  'ticket_live',
  // Responsible play limits
  'exclusion_cannot_shorten',
  'exclusion_not_permanent',
  'exclusion_lift_too_early',
  // Questions and rooms
  'question_rejected',
  'submission_blocked',
  'question_locked',
  'invalid_invite',
  'room_full',
  // Admin
  'void_after_close',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status for each code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
  unavailable: 503,

  turnstile_failed: 403,
  invalid_signature: 401,
  invalid_nonce: 401,
  invalid_token: 401,
  invalid_code: 401,
  code_expired: 401,
  too_many_attempts: 429,
  session_expired: 401,
  account_suspended: 403,
  account_deleted: 403,
  tos_required: 403,

  identity_unverified: 409,
  identity_required: 409,
  identity_locked: 409,
  merge_blocked: 409,
  merge_expired: 410,
  handle_taken: 409,
  deletion_blocked: 409,

  round_not_open: 409,
  round_closed: 409,
  mode_unavailable: 409,
  already_entered: 409,
  stakes_entry_onchain: 400,
  stake_out_of_range: 400,
  insufficient_balance: 409,
  invalid_ciphertext: 400,
  self_excluded: 403,
  not_member: 403,

  not_verified: 403,
  ineligible: 403,
  stakes_disabled: 403,
  stake_cap_reached: 409,
  ticket_live: 409,

  exclusion_cannot_shorten: 409,
  exclusion_not_permanent: 409,
  exclusion_lift_too_early: 409,

  question_rejected: 422,
  submission_blocked: 403,
  question_locked: 409,
  invalid_invite: 404,
  room_full: 409,

  void_after_close: 409,
};

export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** `{ error: { code, message } }`. `message` is human-readable and never parsed by clients. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Builds an error envelope. */
export function errorEnvelope(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}
