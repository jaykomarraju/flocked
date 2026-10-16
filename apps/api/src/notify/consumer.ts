// The `notify` queue consumer (spec "Notifications"; wave-9 pinned interface). For each message:
//   1. claim its dedupe key (dedupe.ts). The day's `outcome` key belongs to the first mode outcome
//      that claims it: that one is the combined message; a later mode's result is app-only, except
//      a refund that is a later event (`laterRefund`), which goes out as `refunded` under its own key;
//   2. resolve the recipient (recipient.ts); self-excluded users get no game notification, and a
//      deleted account nothing;
//   3. render the copy (render.ts) and send it on each of the event's channels that is on in the
//      user's prefs, configured here and reachable for the user (a subscription, a token, an email);
//   4. record each channel reached and finish the key. A transient failure keeps what was reached,
//      gives up the lease and throws, so the queue retries only the rest.
import {
  NOTIFICATION_EVENT_CHANNELS,
  isGameNotification,
  type NotificationChannel,
  type NotifyMessage,
} from '@flocked/shared';
import { now as clockNow } from '../lib/clock.js';
import { log } from '../lib/log.js';
import { channelsFor, type NotifyEnv } from './channels/index.js';
import { claimKey, finishKey, markDelivered, releaseKey } from './dedupe.js';
import { loadRecipient, prefEnabled } from './recipient.js';
import { DEFAULT_ORIGIN, prepare, renderCopy } from './render.js';
import type { Channel, ChannelSet, Delivery } from './types.js';

type OutcomeMessage = Extract<NotifyMessage, { event: 'outcome' }>;

/**
 * Whether an `outcome` refund that arrives after the day's outcome was sent is a later event, told
 * as `refunded` (spec "Notifications": a Stakes refund becoming final, or a rule-7/8 refund after the
 * outcome was sent). Stakes reasons 1 and 6 are final when they happen (`refundTooFew`,
 * `refundTimeout`); 2 and 3 arrive as a provisional proposal first, and their finalization is a
 * `refunded` of its own (src/notify/outcomes.ts). A Free rule 1–4 refund at the reveal stays app-only.
 */
export function laterRefund(p: OutcomeMessage['payload']): boolean {
  if (p.result !== 'refund' || p.refundReason === null) return false;
  if (p.refundReason === 7 || p.refundReason === 8) return true;
  return p.mode === 'stakes' && (p.refundReason === 1 || p.refundReason === 6);
}

/** The `refunded` message that replaces a later-event `outcome` refund. */
export function asRefunded(msg: OutcomeMessage): NotifyMessage {
  const { roundId, mode, refundReason } = msg.payload;
  return {
    event: 'refunded',
    userId: msg.userId,
    dedupeKey: `refunded:${roundId}:${mode}:${msg.userId}`,
    payload: { roundId, mode, refundReason: refundReason ?? 1 },
  };
}

/** The claim source: an outcome's mode (so a second mode is told apart), else the key itself. */
function sourceOf(msg: NotifyMessage): string {
  return msg.event === 'outcome' ? `${msg.payload.roundId}:${msg.payload.mode}` : msg.dedupeKey;
}

/** Raised so the queue retries the message later (another consumer holds it, or a send failed). */
export class NotifyRetry extends Error {
  override readonly name = 'NotifyRetry';
}

export interface NotifyDeps {
  channels: ChannelSet;
  /** The web app's origin for links. */
  origin: string;
  now: () => number;
}

export function defaultNotifyDeps(env: NotifyEnv): NotifyDeps {
  const now = () => clockNow(env);
  return { channels: channelsFor(env, now), origin: env.APP_ORIGIN ?? DEFAULT_ORIGIN, now };
}

/** Handles one `notify` message. Resolves when it was delivered or needs nothing; throws to retry. */
export async function notifyHandler(
  input: NotifyMessage,
  env: NotifyEnv,
  deps: NotifyDeps = defaultNotifyDeps(env),
): Promise<void> {
  const db = env.DB;
  const t = deps.now();
  let msg = input;
  let claim = await claimKey(
    db,
    { key: msg.dedupeKey, userId: msg.userId, event: msg.event, source: sourceOf(msg) },
    t,
  );
  if (claim.kind === 'taken' && msg.event === 'outcome') {
    if (!laterRefund(msg.payload)) {
      log.info('notify_outcome_in_app_only', { dedupeKey: msg.dedupeKey, claimedBy: claim.source });
      return;
    }
    msg = asRefunded(msg);
    claim = await claimKey(
      db,
      { key: msg.dedupeKey, userId: msg.userId, event: msg.event, source: sourceOf(msg) },
      t,
    );
  }
  if (claim.kind === 'done') return;
  if (claim.kind === 'taken') {
    // Two producers built the same key for different things: a producer bug; never send twice.
    log.error('notify_key_conflict', { dedupeKey: msg.dedupeKey, claimedBy: claim.source });
    return;
  }
  if (claim.kind === 'busy') throw new NotifyRetry(`notify ${msg.dedupeKey} is being delivered`);

  const key = msg.dedupeKey;
  try {
    const delivered = await deliver(env, deps, msg, new Set(claim.delivered), t);
    if (!delivered) {
      await releaseKey(db, key);
      throw new NotifyRetry(`notify ${key}: a channel failed`);
    }
    await finishKey(db, key, t);
  } catch (err) {
    if (!(err instanceof NotifyRetry)) await releaseKey(db, key).catch(() => undefined);
    throw err;
  }
}

/** Sends `msg` on every channel it still needs. Returns false when one must be retried. */
async function deliver(
  env: NotifyEnv,
  deps: NotifyDeps,
  msg: NotifyMessage,
  done: ReadonlySet<string>,
  t: number,
): Promise<boolean> {
  const db = env.DB;
  const recipient = await loadRecipient(db, msg.userId, t);
  if (!recipient) {
    log.info('notify_no_recipient', { event: msg.event, dedupeKey: msg.dedupeKey });
    return true;
  }
  if (recipient.excluded && isGameNotification(msg.event)) {
    log.info('notify_excluded', { event: msg.event, dedupeKey: msg.dedupeKey });
    return true;
  }
  const channels = (
    NOTIFICATION_EVENT_CHANNELS[msg.event] as readonly NotificationChannel[]
  ).filter((c) => !done.has(c) && prefEnabled(recipient, c, msg.event));
  const ready: Channel[] = [];
  for (const c of channels) {
    const channel: Channel | undefined = deps.channels[c];
    if (!channel) {
      log.info('notify_channel_unconfigured', { channel: c, event: msg.event });
      continue;
    }
    if (channel.available(recipient)) ready.push(channel);
  }
  if (ready.length === 0) return true;

  const prepared = await prepare(db, msg, recipient.userId);
  if (!prepared) {
    log.warn('notify_unrenderable', { event: msg.event, dedupeKey: msg.dedupeKey });
    return true;
  }
  let ok = true;
  for (const channel of ready) {
    const copy = renderCopy(channel.name, msg.event, prepared);
    if (!copy) continue;
    const delivery: Delivery = {
      event: msg.event,
      dedupeKey: msg.dedupeKey,
      recipient,
      copy,
      targetUrl: new URL(prepared.path, deps.origin).toString(),
      nextLive: prepared.nextLive,
    };
    try {
      const out = await channel.send([delivery]);
      if (out.retry.length > 0) {
        ok = false;
        continue;
      }
      await markDelivered(db, msg.dedupeKey, channel.name);
    } catch (err) {
      log.warn('notify_channel_failed', {
        channel: channel.name,
        dedupeKey: msg.dedupeKey,
        error: err instanceof Error ? err.message : String(err),
      });
      ok = false;
    }
  }
  return ok;
}
