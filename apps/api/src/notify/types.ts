// Notification senders (wave-9 pinned interface): `channels/{farcaster,webpush,email}.ts` each
// implement `Channel.send(batch)`. The notify consumer (consumer.ts) renders one Delivery per channel
// from packages/shared/src/copy/notifications.ts and hands it over; a channel only transports.
import type { EmailCopy, NotificationChannel, NotificationEvent, PushCopy } from '@flocked/shared';

/** A web push subscription (`push_subscriptions` row). */
export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A Farcaster mini app notification token (`farcaster_notification_tokens` row). */
export interface FarcasterTarget {
  fid: number;
  appFid: number;
  url: string;
  token: string;
}

/** Where a user can be reached, resolved once per message (recipient.ts). */
export interface Recipient {
  /** The account notified: the message's user, or the account it was merged into. */
  userId: string;
  /** Self-excluded now (spec "Data model" › limits: the one exclusion rule). */
  excluded: boolean;
  /** The verified email identity's address, if any. */
  email: string | null;
  pushSubscriptions: readonly PushTarget[];
  farcasterTokens: readonly FarcasterTarget[];
  /** Stored `notification_prefs` rows, keyed `${channel}:${event}`. */
  prefs: ReadonlyMap<string, boolean>;
}

/** The copy shape a channel sends. */
export type ChannelCopy<C extends NotificationChannel> = C extends 'email' ? EmailCopy : PushCopy;

/** One rendered notification for one user on one channel. */
export interface Delivery<C extends NotificationChannel = NotificationChannel> {
  event: NotificationEvent;
  dedupeKey: string;
  recipient: Recipient;
  copy: ChannelCopy<C>;
  /** The absolute URL the notification opens (`APP_ORIGIN` + the event's path). */
  targetUrl: string;
  /** `outcome` only: the next question is live (the combined message's last line). */
  nextLive?: boolean;
}

/** What a channel did with a batch: the dedupe keys of deliveries to try again later. */
export interface SendOutcome {
  retry: readonly string[];
}

export interface Channel<C extends NotificationChannel = NotificationChannel> {
  readonly name: C;
  /** Whether the recipient can be reached here (a subscription, a token, a verified email). */
  available(recipient: Recipient): boolean;
  /**
   * Sends every delivery. A permanent failure (a gone subscription, a refused payload) is logged and
   * not retried; a transient one is listed in `retry`. Throws only when nothing could be attempted.
   */
  send(batch: readonly Delivery<C>[]): Promise<SendOutcome>;
}

/** The channels the consumer can use; a channel without its configuration is absent. */
export type ChannelSet = { readonly [C in NotificationChannel]?: Channel<C> };
