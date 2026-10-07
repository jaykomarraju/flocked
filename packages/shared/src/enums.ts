// Enum values shared across apps and packages. Each list mirrors Product_Spec.md; the tests in
// test/enums.test.ts pin them. VoidReason, RefundReason and OptionIndex live in @flocked/settle.

/** Play mode (`round_modes.mode`). Spec: "Modes: Free and Stakes". */
export const MODES = ['free', 'stakes'] as const;
export type Mode = (typeof MODES)[number];

/** `rounds.kind`. Spec: "Data model". */
export const ROUND_KINDS = ['daily', 'room'] as const;
export type RoundKind = (typeof ROUND_KINDS)[number];

/** `rounds.status`, schedule level. Spec: "Round lifecycle", "Data model" (Status enums). */
export const ROUND_STATUSES = ['scheduled', 'open', 'closed'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

/**
 * `round_modes.status`. The two `_proposed` values are Stakes only and mirror the contract.
 * Spec: "Round lifecycle", "Data model" (Status enums).
 */
export const MODE_STATUSES = [
  'pending',
  'revealing',
  'settle_proposed',
  'refund_proposed',
  'settled',
  'refunded',
  'voided',
] as const;
export type ModeStatus = (typeof MODE_STATUSES)[number];

/** Terminal mode statuses. */
export const TERMINAL_MODE_STATUSES = [
  'settled',
  'refunded',
  'voided',
] as const satisfies readonly ModeStatus[];

/** Question category tag. Spec: "Core game rules" (Question format). */
export const CATEGORIES = [
  'food',
  'life',
  'tech',
  'money',
  'pop',
  'hypothetical',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** `identities.provider`. Spec: "Data model". */
export const PROVIDERS = ['farcaster', 'wallet', 'email', 'coinbase'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** `users.status`. Spec: "Data model". */
export const USER_STATUSES = ['active', 'suspended', 'merged', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Notification events, in table order. Spec: "Notifications". */
export const NOTIFICATION_EVENTS = [
  'question_live',
  'closing_soon',
  'outcome',
  'payout_claimable',
  'refunded',
  'question_used',
  'streak_at_risk',
  'question_edited',
  'security_notice',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Narrows an unknown string to a member of one of the lists above. */
export function isOneOf<const T extends readonly string[]>(
  list: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}
