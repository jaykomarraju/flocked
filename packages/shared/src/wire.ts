// Shared zod primitives for every JSON surface (REST, WebSocket, queues). Plan P2.4.
//
// The schemas validate the wire form only and never transform it, so the same schema decodes on
// one side and checks what is about to be encoded on the other, and `parse` output re-serializes
// to the input. Conversions (decimal string to bigint and back) are explicit helpers below.
// The only exception is `LimitQuerySchema`, which coerces a query-string number.

import { VOID_REASONS } from '@flocked/settle';
import { z } from 'zod';

import {
  CATEGORIES,
  MODE_STATUSES,
  MODES,
  NOTIFICATION_EVENTS,
  PROVIDERS,
  ROUND_KINDS,
  ROUND_STATUSES,
  USER_STATUSES,
} from './enums';

// ---------------------------------------------------------------------------------------------
// Money and integers

/**
 * A non-negative integer as a decimal string with no sign and no leading zeros (`0`, `12`, ...),
 * at most 78 digits (uint256). Every amount on the wire uses it: points, USDC base units, pools,
 * caps and chain round IDs. Never a JSON number. Plan P2.4.
 */
export const DecimalBigintSchema = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/, 'expected a non-negative decimal integer string');

/** A signed integer as a decimal string (`0`, `-12`, `12`); for deltas and net results. */
export const SignedDecimalBigintSchema = z
  .string()
  .max(79)
  .regex(/^(0|-?[1-9][0-9]*)$/, 'expected a decimal integer string');

/** Decodes a wire amount (`DecimalBigintSchema` or `SignedDecimalBigintSchema`). */
export function decimalToBigint(value: string): bigint {
  if (!/^(0|-?[1-9][0-9]*)$/.test(value)) throw new RangeError(`not a decimal integer: ${value}`);
  return BigInt(value);
}

/** Encodes an amount for the wire. Pass `{ signed: true }` for deltas that may be negative. */
export function bigintToDecimal(value: bigint, opts: { signed?: boolean } = {}): string {
  if (value < 0n && opts.signed !== true) throw new RangeError(`negative amount: ${value}`);
  return value.toString(10);
}

/** Basis points, 0..10000. */
export const BpsSchema = z.int().min(0).max(10_000);

/** A non-negative safe integer (counts, sequence numbers, block numbers). */
export const CountSchema = z.int().min(0);

// ---------------------------------------------------------------------------------------------
// Time

/**
 * Unix time in SECONDS, for beacon math and onchain values: `opensAt`, `closesAt`, `beaconTime`,
 * and the seconds fields of signed tickets and receipts. Bounded below 10^10 so a millisecond
 * value is rejected. Plan P2.4.
 */
export const UnixSecondsSchema = z.int().min(0).max(9_999_999_999);

/**
 * Epoch MILLISECONDS for every other time (`createdAt`, `revealedAt`, `claimsOpenAt`, ...).
 * Bounded to [10^12, 10^13) (years 2001 to 2286) so a seconds value is rejected. Plan P2.4.
 */
export const EpochMsSchema = z.int().min(1_000_000_000_000).max(9_999_999_999_999);

/** A drand round number. */
export const BeaconRoundSchema = z.int().min(1);

function isCalendarDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * A game day, `YYYY-MM-DD`: the New York date on which a round closes.
 * Spec: "Profiles, leaderboards and rooms" (Game day and streaks).
 */
export const GameDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isCalendarDate, 'not a calendar date');

/** An ISO week, `YYYY-Www` (weekly boards use the ISO week of the game day). */
export const IsoWeekSchema = z
  .string()
  .regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, 'expected YYYY-Www');

// ---------------------------------------------------------------------------------------------
// Identifiers and bytes

/**
 * A ULID: 26 uppercase Crockford base32 characters, first character 0-7 (48-bit time).
 * Every table ID (`rounds.id`, `users.id`, ...) uses it.
 */
export const UlidSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'expected a ULID');

/**
 * An EVM address in its one wire form: lowercase `0x` + 40 hex. Checksummed (EIP-55) input is
 * rejected, so equality is string equality and matches `identities.external_id` (lowercase).
 * Clients lowercase wallet addresses before sending and may checksum them for display.
 */
export const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase address');

/** 32 bytes as lowercase `0x` hex (hashes, Merkle roots, tx hashes, person tags). */
export const Hex32Schema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, 'expected 32 bytes of lowercase hex');

/** Any byte string as lowercase `0x` hex (whole bytes). */
export const HexBytesSchema = z
  .string()
  .regex(/^0x(?:[0-9a-f]{2})*$/, 'expected lowercase hex bytes');

/** A 65-byte ECDSA signature (r, s, v) as lowercase hex: tickets and receipts. */
export const EcdsaSignatureSchema = z
  .string()
  .regex(/^0x[0-9a-f]{130}$/, 'expected a 65-byte signature');

/**
 * Binary data as base64url without padding (RFC 4648 section 5). Ciphertexts (binary age files,
 * plan P2.1) travel this way in JSON.
 */
export const Base64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/, 'expected unpadded base64url')
  .refine((s) => s.length % 4 !== 1, 'invalid base64url length');

/** An age ciphertext in base64url. The plaintext is 34 bytes, so 4 KiB of text is generous. */
export const CiphertextSchema = Base64UrlSchema.min(1).max(4096);

/** An opaque share ID (`share_cards.share_id`). */
export const ShareIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/, 'expected a share ID');

/** A Turnstile response token. */
export const TurnstileTokenSchema = z.string().min(1).max(2048);

/** An absolute http(s) URL. */
export const HttpUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * A user handle: 3-20 characters of lowercase letters, digits, `_` and `-`. The spec does not
 * define handle syntax; this is the W2-D default (recorded as a spec issue).
 */
export const HandleSchema = z.string().regex(/^[a-z0-9_-]{3,20}$/, 'expected a handle');

/** A user's stable referral code (`users.ref_code`). */
export const RefCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{4,32}$/, 'expected a ref code');

/** An email address. */
export const EmailSchema = z.email().max(254);

// ---------------------------------------------------------------------------------------------
// Enums (lists live in ./enums and @flocked/settle)

/** The chosen option, 0 or 1. Spec: "Core game rules". */
export const OptionIndexSchema = z.union([z.literal(0), z.literal(1)]);

export const ModeSchema = z.enum(MODES);
export const RoundKindSchema = z.enum(ROUND_KINDS);
export const RoundStatusSchema = z.enum(ROUND_STATUSES);
export const ModeStatusSchema = z.enum(MODE_STATUSES);
export const CategorySchema = z.enum(CATEGORIES);
export const ProviderSchema = z.enum(PROVIDERS);
export const UserStatusSchema = z.enum(USER_STATUSES);
export const NotificationEventSchema = z.enum(NOTIFICATION_EVENTS);

/** Entry VOID reasons (`entries.void_reason`), from `@flocked/settle`. */
export const VoidReasonSchema = z.enum(VOID_REASONS);

/** Refund reason codes 1-8 (`round_modes.refund_reason`). Spec: "Settlement and payout math". */
export const RefundReasonCodeSchema = z.int().min(1).max(8);

/** `users.role`. Spec: "Data model". */
export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const UserRoleSchema = z.enum(USER_ROLES);

/** `payouts.kind`. Spec: "Data model". */
export const PAYOUT_KINDS = ['win', 'rebate', 'void_refund', 'refund'] as const;
export type PayoutKind = (typeof PAYOUT_KINDS)[number];
export const PayoutKindSchema = z.enum(PAYOUT_KINDS);

// ---------------------------------------------------------------------------------------------
// Pagination

/** A `limit` query parameter: 1..100, coerced from the query string. */
export const LimitQuerySchema = z.coerce.number().int().min(1).max(100);

/** An opaque pagination cursor. */
export const CursorSchema = z.string().min(1).max(256);

/** Path params `{ id }` where the ID is a ULID (`/rounds/:id`, `/rooms/:id`, ...). */
export const IdParamsSchema = z.object({ id: UlidSchema });
export type IdParams = z.infer<typeof IdParamsSchema>;
