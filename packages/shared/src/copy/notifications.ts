// Notification copy (Product_Spec.md "Notifications"; Design_Language.md "Voice" and the refund lines). The final
// lines for every event in NOTIFICATION_EVENTS on every channel in NOTIFICATION_CHANNELS, designed in Paper (page
// "Cards and notifications", W6-C.2). Voice: short, dry, deadpan; never explain the joke; never use exclamation
// points. Templates hold `{placeholder}`s from NOTIFICATION_PLACEHOLDERS; the notify consumer formats the values.

import type { NotificationChannel } from '../api/me';
import { VOICE } from '../copy';
import type { NotificationEvent } from '../enums';
import type { SECURITY_NOTICE_KINDS } from '../queues';
import type { RefundReason } from '../reasons';

export type SecurityNoticeKind = (typeof SECURITY_NOTICE_KINDS)[number];

/** The channels each event is sent on (spec "Notifications", Channels column). Any other channel is not sent. */
export const NOTIFICATION_EVENT_CHANNELS = {
  question_live: ['farcaster', 'webpush'],
  closing_soon: ['farcaster', 'webpush'],
  outcome: ['farcaster', 'webpush', 'email'],
  payout_claimable: ['webpush', 'email'],
  refunded: ['farcaster', 'webpush', 'email'],
  question_used: ['farcaster', 'webpush'],
  streak_at_risk: ['farcaster', 'webpush'],
  question_edited: ['farcaster', 'webpush'],
  security_notice: ['farcaster', 'webpush', 'email'],
} as const satisfies Record<NotificationEvent, readonly NotificationChannel[]>;

/** Self-excluded users receive no game notifications; security notices are not game notifications. */
export function isGameNotification(event: NotificationEvent): boolean {
  return event !== 'security_notice';
}

/**
 * Template placeholders. The consumer passes formatted strings:
 * - `amount`: the signed net change with its unit, "+86 pts" or "+16.00 USDC" (outcome `amount`);
 * - `payout`: an unsigned amount with its unit, "17.67 USDC" (payout_claimable `amount`);
 * - `share`: the player's side as `formatShare(count, total, side)`, "38%" (read from the tally);
 * - `question`: the round's prompt (1–120 characters);
 * - `streak`: the stray streak, "3";
 * - `refundLine`: `REFUND_LINES[refundReason]`;
 * - `mode`: "Free" or "Stakes".
 */
export const NOTIFICATION_PLACEHOLDERS = [
  'amount',
  'payout',
  'share',
  'question',
  'streak',
  'refundLine',
  'mode',
] as const;
export type NotificationPlaceholder = (typeof NOTIFICATION_PLACEHOLDERS)[number];
export type NotificationValues = Partial<Record<NotificationPlaceholder, string>>;

/** Farcaster mini app notifications cap the title at 32 characters and the body at 128. Web push uses the same. */
export const PUSH_LIMITS = { title: 32, body: 128 } as const;

/** A Farcaster mini app notification or a web push notification. */
export interface PushCopy {
  readonly title: string;
  readonly body: string;
}

/** An email: `heading` is the big line, `body` the paragraph under it, `cta` the one button. */
export interface EmailCopy {
  readonly subject: string;
  readonly preheader: string;
  readonly heading: string;
  readonly body: string;
  readonly cta: string;
}

type AllEvents<T extends Record<NotificationEvent, string>> = T;

/** The copy variants of each event. `outcome` uses `win_no_amount` when its `amount` is null. */
export type NotificationVariant = AllEvents<{
  question_live: 'default';
  closing_soon: 'default';
  outcome: 'win' | 'win_no_amount' | 'loss' | 'refund' | 'void';
  payout_claimable: 'default';
  refunded: 'free' | 'stakes';
  question_used: 'scheduled' | 'settled';
  streak_at_risk: 'default';
  question_edited: 'default';
  security_notice: SecurityNoticeKind;
}>;

type ChannelCopy<C extends NotificationChannel> = C extends 'email' ? EmailCopy : PushCopy;

/** Copy for every event and channel; `null` means the event is not sent on that channel. */
export type NotificationCopyTable = {
  readonly [E in NotificationEvent]: {
    readonly [C in NotificationChannel]:
      | {
          readonly [V in NotificationVariant[E]]: ChannelCopy<C>;
        }
      | null;
  };
};

/** One line per refund reason, exactly as in Design_Language.md (rule 3 is the "Refunded (tie only)" line). */
export const REFUND_LINES: Readonly<Record<RefundReason, string>> = {
  1: 'Not enough sheep showed up. Everyone gets their stake back.',
  2: 'Everyone picked the same side. No strays, no round. Everyone gets their stake back.',
  3: VOICE.refundedTie,
  4: 'This round was called off before it closed. Everyone gets their stake back.',
  5: 'The result was challenged and thrown out. Everyone gets their stake back.',
  6: 'No result was posted in time. Everyone gets their stake back.',
  7: "The picks weren't locked in on time, so this round doesn't count. Points returned.",
  8: 'The timelock never opened, so the picks stay sealed. Points returned.',
};

/**
 * `outcome` is one combined message (spec): when `nextRoundId` is set, push bodies end with this sentence after a
 * space, and emails add it as a paragraph above the `EMAIL_NEXT_LINK` link.
 */
export const OUTCOME_NEXT_LIVE = 'The next question is live.';
export const EMAIL_NEXT_LINK = 'Play the next question';

/** Email chrome: the sender name and the footer lines. */
export const EMAIL_CHROME = {
  fromName: 'Flocked',
  footerOptional: 'You get this email because it is on in your notification settings.',
  footerRequired: 'Security notices are always on.',
  manageLink: 'Manage notifications',
} as const;

const push = (title: string, body: string): PushCopy => ({ title, body });

const QUESTION_LIVE = { default: push("Today's question is live", '{question}') };
const CLOSING_SOON = {
  default: push(
    'An hour left',
    "Today's question closes in an hour. The flock is forming without you.",
  ),
};
const OUTCOME_PUSH = {
  win: push('Unflocked {amount}', 'You and {share} of people out-thought everyone.'),
  win_no_amount: push('Unflocked', 'You and {share} of people out-thought everyone.'),
  loss: push('You got flocked', '{share} thought the same thing you did.'),
  refund: push('{mode} round refunded', '{refundLine}'),
  void: push("Your pick didn't count", 'It was left out of the count and your stake is back.'),
};
const PAYOUT_PUSH = {
  default: push(
    'Ready to claim',
    '{payout} is ready to claim. It goes to the wallet that entered.',
  ),
};
const REFUNDED_PUSH = {
  free: push('Free round refunded', '{refundLine}'),
  stakes: push('Stakes round refunded', '{refundLine} Your refund is waiting in Claims.'),
};
const QUESTION_USED = {
  scheduled: push(
    'Your question made the cut',
    "It's on the schedule. We'll tell you how the flock splits.",
  ),
  settled: push('Your question settled', 'See how the flock split on it.'),
};
const STREAK_AT_RISK = {
  default: push(
    '{streak}-day stray streak',
    "Today's question closes in 3 hours. Sit it out and the streak ends.",
  ),
};
const QUESTION_EDITED = {
  default: push('Your question was edited', 'We changed its wording. See the new version.'),
};
const SECURITY_PUSH = {
  email_sign_in: push(
    'New sign-in with email',
    "Someone just signed in to your account with your email. If that wasn't you, check Settings.",
  ),
  identity_linked: push(
    'New sign-in method',
    "A sign-in method was linked to your account. If that wasn't you, check Settings.",
  ),
  merge_pending: push(
    'Account merge pending',
    'A request to merge two of your Flocked accounts is waiting. Confirm it in Settings by signing in to both, or ignore it.',
  ),
  merge_completed: push(
    'Accounts merged',
    "Your accounts are now one. If that wasn't you, check Settings.",
  ),
};

/** The notification copy, keyed by event, then channel, then variant. */
export const NOTIFICATION_COPY: NotificationCopyTable = {
  question_live: { farcaster: QUESTION_LIVE, webpush: QUESTION_LIVE, email: null },
  closing_soon: { farcaster: CLOSING_SOON, webpush: CLOSING_SOON, email: null },
  outcome: {
    farcaster: OUTCOME_PUSH,
    webpush: OUTCOME_PUSH,
    email: {
      win: {
        subject: 'Unflocked {amount}',
        preheader: 'You and {share} of people out-thought everyone.',
        heading: 'UNFLOCKED {amount}',
        body: 'You and {share} of people out-thought everyone.',
        cta: 'See the reveal',
      },
      win_no_amount: {
        subject: 'Unflocked',
        preheader: 'You and {share} of people out-thought everyone.',
        heading: 'UNFLOCKED',
        body: 'You and {share} of people out-thought everyone.',
        cta: 'See the reveal',
      },
      loss: {
        subject: 'You got flocked',
        preheader: '{share} thought the same thing you did.',
        heading: 'GOT FLOCKED',
        body: '{share} thought the same thing you did.',
        cta: 'See the reveal',
      },
      refund: {
        subject: '{mode} round refunded',
        preheader: '{refundLine}',
        heading: 'Refunded',
        body: '{refundLine}',
        cta: 'See the round',
      },
      void: {
        subject: "Your pick didn't count",
        preheader: 'It was left out of the count and your stake is back.',
        heading: "Your pick didn't count",
        body: 'It was left out of the count and your stake is back.',
        cta: 'See the round',
      },
    },
  },
  payout_claimable: {
    farcaster: null,
    webpush: PAYOUT_PUSH,
    email: {
      default: {
        subject: '{payout} is ready to claim',
        preheader: 'The result is final and claims are open.',
        heading: 'Ready to claim',
        body: 'The result is final and claims are open. Payouts go to the wallet that entered.',
        cta: 'Claim {payout}',
      },
    },
  },
  refunded: {
    farcaster: REFUNDED_PUSH,
    webpush: REFUNDED_PUSH,
    email: {
      free: {
        subject: 'Free round refunded',
        preheader: '{refundLine}',
        heading: 'Refunded',
        body: '{refundLine}',
        cta: 'See the round',
      },
      stakes: {
        subject: 'Stakes round refunded',
        preheader: '{refundLine}',
        heading: 'Refunded',
        body: '{refundLine} Your refund is waiting in Claims.',
        cta: 'Go to Claims',
      },
    },
  },
  question_used: { farcaster: QUESTION_USED, webpush: QUESTION_USED, email: null },
  streak_at_risk: { farcaster: STREAK_AT_RISK, webpush: STREAK_AT_RISK, email: null },
  question_edited: { farcaster: QUESTION_EDITED, webpush: QUESTION_EDITED, email: null },
  security_notice: {
    farcaster: SECURITY_PUSH,
    webpush: SECURITY_PUSH,
    email: {
      email_sign_in: {
        subject: 'New sign-in with email',
        preheader: 'Someone just signed in to your account with your email.',
        heading: 'New sign-in with email',
        body: "Someone just signed in to your Flocked account with your email. If that was you, there's nothing to do. If it wasn't, review your sign-in methods.",
        cta: 'Open Settings',
      },
      identity_linked: {
        subject: 'New sign-in method',
        preheader: 'A sign-in method was linked to your account.',
        heading: 'New sign-in method',
        body: "A sign-in method was linked to your Flocked account. If that was you, there's nothing to do. If it wasn't, remove it in Settings.",
        cta: 'Open Settings',
      },
      merge_pending: {
        subject: 'Account merge pending',
        preheader: 'A request to merge two of your accounts is waiting.',
        heading: 'Account merge pending',
        body: "Someone asked to merge another Flocked account with yours. Nothing changes unless it's confirmed by signing in to both accounts. It expires in 7 days if nobody acts on it.",
        cta: 'Review it in Settings',
      },
      merge_completed: {
        subject: 'Accounts merged',
        preheader: 'Your accounts are now one.',
        heading: 'Accounts merged',
        body: "Your accounts are now one. If that wasn't you, review your sign-in methods.",
        cta: 'Open Settings',
      },
    },
  },
};

/** Fills a template's `{placeholder}`s. Throws on an unknown placeholder or one without a value. */
export function fillCopy(template: string, values: NotificationValues): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(NOTIFICATION_PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new RangeError(`unknown placeholder {${name}}`);
    }
    const value = values[name as NotificationPlaceholder];
    if (value === undefined) throw new RangeError(`no value for {${name}}`);
    return value;
  });
}
