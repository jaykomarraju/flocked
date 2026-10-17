// The `notify` queue consumer (spec "Notifications"; wave-9 pinned interface). For each message:
//   1. claim its dedupe key (dedupe.ts). The day's `outcome` key belongs to the first mode outcome
//      that claims it: that one is the combined message; a later mode's result is app-only, except
//      a refund that is a later event (`laterRefund`), which goes out as `refunded` under its own key;
//   2. resolve the recipient (recipient.ts); self-excluded users get no game notification, and a
//      deleted account nothing;
//   3. render the copy (render.ts) and send it on each of the event's channels that is on in the
//      user's prefs, configured here and reachable for the user (a subscription, a token, an email);
//   4. record each channel reached and finish the key, each write fenced by the claim's lease
//      (dedupe.ts), so a delivery that ran past its lease writes nothing to a key another one holds.
//      A transient failure keeps what was reached, gives up the lease and throws, so the queue
//      retries only the rest.
// `notifyBatch` runs steps 1–2 per message, then step 3 once per channel for the whole queue batch
// (so Farcaster can put identical notifications into one request), then step 4 per message.
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_CHANNELS,
  NotifyMessageSchema,
  isGameNotification,
  type NotificationChannel,
  type NotifyMessage,
} from '@flocked/shared';
import { now as clockNow } from '../lib/clock.js';
import { log } from '../lib/log.js';
import { channelsFor, type NotifyEnv } from './channels/index.js';
import { claimKey, finishKey, markDelivered, releaseKey, type Lease } from './dedupe.js';
import { loadRecipient, prefEnabled } from './recipient.js';
import { DEFAULT_ORIGIN, prepare, renderCopy } from './render.js';
import type { Channel, ChannelSet, Delivery } from './types.js';

type OutcomeMessage = Extract<NotifyMessage, { event: 'outcome' }>;

/**
 * Whether an `outcome` refund that arrives after the day's outcome was sent is a later event, told
 * as `refunded` (spec "Notifications": a Stakes refund becoming final, or a rule-7/8 refund after the
 * outcome was sent). A Stakes refund with no proposal is final when it happens (`refundTooFew`,
 * reason 1, and `refundTimeout`, 6). A proposed one (`provisional`, any reason: VOID entries can
 * leave too few valid ones for rule 1) is not a later event at the proposal — 2 h before claims open,
 * with a veto still possible — and goes out as `refunded` when it becomes final, enqueued by
 * `notifyOnModeFinal` under its own key (src/notify/outcomes.ts; W9-F1 R2). A Free rule 1–4 refund at
 * the reveal stays app-only.
 */
export function laterRefund(p: OutcomeMessage['payload']): boolean {
  if (p.result !== 'refund' || p.refundReason === null) return false;
  if (p.refundReason === 7 || p.refundReason === 8) return true;
  if (p.provisional === true) return false;
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

/** What happened to one message of a batch: delivered (or nothing to deliver), or retry it later. */
export type NotifyResult = 'ok' | 'retry';

/** A claimed message with its rendered deliveries, waiting for the channels' batched sends. */
interface Planned {
  index: number;
  key: string;
  /** The claim's fence: every write on the key carries it (dedupe.ts). */
  lease: Lease;
  deliveries: Map<NotificationChannel, Delivery>;
}

/**
 * Handles a batch of `notify` messages: claims and renders each one, then hands every channel all of
 * the batch's deliveries for it in one `send` (Farcaster groups identical sends into one request of
 * up to 100 tokens), then records each message's channels and finishes or releases its key. Returns
 * one result per input, in order.
 */
export async function notifyBatch(
  inputs: readonly NotifyMessage[],
  env: NotifyEnv,
  deps: NotifyDeps = defaultNotifyDeps(env),
): Promise<NotifyResult[]> {
  const db = env.DB;
  const results: NotifyResult[] = inputs.map(() => 'ok');
  const planned: Planned[] = [];
  for (const [index, input] of inputs.entries()) {
    // The clock is read per message, not once per batch: a batch can take longer than a lease, so a
    // claim stamped from the batch's start would hold a lease that is already in the past (R3).
    const t = deps.now();
    try {
      const p = await plan(env, deps, input, t);
      if (p === 'retry') results[index] = 'retry';
      else if (p !== null) {
        if (p.deliveries.size === 0) await finishKey(db, p.key, t, p.lease);
        else planned.push({ index, ...p });
      }
    } catch (err) {
      log.warn('notify_plan_failed', {
        event: input.event,
        dedupeKey: input.dedupeKey,
        error: err instanceof Error ? err.message : String(err),
      });
      results[index] = 'retry';
    }
  }

  // One send per channel for the whole batch. A delivery listed in `retry`, or in a send that threw,
  // is retried with its message; the others count as reached.
  const failed = new Set<string>();
  const sendFailed = (channel: NotificationChannel, key: string) =>
    failed.add(`${channel}\n${key}`);
  for (const name of NOTIFICATION_CHANNELS) {
    const batch = planned.flatMap((p) => p.deliveries.get(name) ?? []);
    const channel: Channel | undefined = deps.channels[name];
    if (batch.length === 0 || !channel) continue;
    try {
      const out = await channel.send(batch);
      for (const key of out.retry) sendFailed(name, key);
    } catch (err) {
      log.warn('notify_channel_failed', {
        channel: name,
        deliveries: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
      for (const d of batch) sendFailed(name, d.dedupeKey);
    }
  }

  for (const p of planned) {
    const t = deps.now();
    let ok = true;
    let lost = false;
    try {
      for (const name of p.deliveries.keys()) {
        if (failed.has(`${name}\n${p.key}`)) ok = false;
        else if (!(await markDelivered(db, p.key, name, p.lease))) lost = true;
        if (lost) break;
      }
      if (!lost) {
        lost = ok
          ? !(await finishKey(db, p.key, t, p.lease))
          : !(await releaseKey(db, p.key, p.lease));
      }
    } catch (err) {
      log.warn('notify_record_failed', {
        dedupeKey: p.key,
        error: err instanceof Error ? err.message : String(err),
      });
      await releaseKey(db, p.key, p.lease).catch(() => undefined);
      ok = false;
    }
    if (lost) {
      // This delivery took longer than its lease and another one holds the key now: that one records
      // and finishes it, so nothing is written here and this message isn't retried either (R3).
      log.warn('notify_lease_lost', { dedupeKey: p.key, event: inputs[p.index]?.event });
      continue;
    }
    if (!ok) results[p.index] = 'retry';
  }
  return results;
}

/** Handles one `notify` message. Resolves when it was delivered or needs nothing; throws to retry. */
export async function notifyHandler(
  input: NotifyMessage,
  env: NotifyEnv,
  deps: NotifyDeps = defaultNotifyDeps(env),
): Promise<void> {
  const [result] = await notifyBatch([input], env, deps);
  if (result === 'retry') throw new NotifyRetry(`notify ${input.dedupeKey}: retry later`);
}

/**
 * The `notify` queue's batch entry point (W9-D wires it in `queue()`, so a batch is sent together):
 * validates each message like `handleMessage`, then acks or retries each one by its result.
 */
export async function notifyQueueBatch(
  batch: MessageBatch<unknown>,
  env: NotifyEnv,
  deps: NotifyDeps = defaultNotifyDeps(env),
): Promise<void> {
  const valid: { message: Message<unknown>; body: NotifyMessage }[] = [];
  for (const message of batch.messages) {
    const parsed = NotifyMessageSchema.safeParse(message.body);
    if (parsed.success) valid.push({ message, body: parsed.data });
    else {
      log.error('queue_message_invalid', {
        queue: 'notify',
        messageId: message.id,
        attempts: message.attempts,
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      message.ack();
    }
  }
  const results = await notifyBatch(
    valid.map((v) => v.body),
    env,
    deps,
  );
  for (const [i, { message }] of valid.entries()) {
    if (results[i] === 'retry') message.retry();
    else message.ack();
  }
}

/**
 * Claims `input`'s key and renders it for every channel it still needs. Returns null when nothing is
 * to be sent and the key needs no finishing (a repeat, or a second mode's outcome), 'retry' when
 * another consumer holds the key, or the claimed key with its deliveries (none: finish it).
 */
async function plan(
  env: NotifyEnv,
  deps: NotifyDeps,
  input: NotifyMessage,
  t: number,
): Promise<
  | {
      key: string;
      lease: Lease;
      deliveries: Map<NotificationChannel, Delivery>;
    }
  | 'retry'
  | null
> {
  const db = env.DB;
  let msg = input;
  let claim = await claimKey(
    db,
    { key: msg.dedupeKey, userId: msg.userId, event: msg.event, source: sourceOf(msg) },
    t,
  );
  if (claim.kind === 'taken' && msg.event === 'outcome') {
    if (!laterRefund(msg.payload)) {
      log.info('notify_outcome_in_app_only', { dedupeKey: msg.dedupeKey, claimedBy: claim.source });
      return null;
    }
    msg = asRefunded(msg);
    claim = await claimKey(
      db,
      { key: msg.dedupeKey, userId: msg.userId, event: msg.event, source: sourceOf(msg) },
      t,
    );
  }
  if (claim.kind === 'done') return null;
  if (claim.kind === 'taken') {
    // Two producers built the same key for different things: a producer bug; never send twice.
    log.error('notify_key_conflict', { dedupeKey: msg.dedupeKey, claimedBy: claim.source });
    return null;
  }
  if (claim.kind === 'busy') return 'retry';
  const { lease } = claim;
  try {
    return { lease, ...(await render(env, deps, msg, new Set(claim.delivered), t)) };
  } catch (err) {
    await releaseKey(db, msg.dedupeKey, lease).catch(() => undefined);
    throw err;
  }
}

/** The deliveries for a claimed message on each channel it still needs (`done`: already reached). */
async function render(
  env: NotifyEnv,
  deps: NotifyDeps,
  msg: NotifyMessage,
  done: ReadonlySet<string>,
  t: number,
): Promise<{ key: string; deliveries: Map<NotificationChannel, Delivery> }> {
  const db = env.DB;
  const key = msg.dedupeKey;
  const deliveries = new Map<NotificationChannel, Delivery>();
  const recipient = await loadRecipient(db, msg.userId, t);
  if (!recipient) {
    log.info('notify_no_recipient', { event: msg.event, dedupeKey: key });
    return { key, deliveries };
  }
  if (recipient.excluded && isGameNotification(msg.event)) {
    log.info('notify_excluded', { event: msg.event, dedupeKey: key });
    return { key, deliveries };
  }
  const ready: Channel[] = [];
  for (const c of NOTIFICATION_EVENT_CHANNELS[msg.event] as readonly NotificationChannel[]) {
    if (done.has(c) || !prefEnabled(recipient, c, msg.event)) continue;
    const channel: Channel | undefined = deps.channels[c];
    if (!channel) log.info('notify_channel_unconfigured', { channel: c, event: msg.event });
    else if (channel.available(recipient)) ready.push(channel);
  }
  if (ready.length === 0) return { key, deliveries };

  // Rendered from the account the payload names, not the one it is delivered to: a merge never
  // re-points `entries`, so an outcome enqueued before a merge (or retried after one) must still
  // find its entry and tally (W9-F1 R4).
  const prepared = await prepare(db, msg, msg.userId);
  if (!prepared) {
    log.warn('notify_unrenderable', { event: msg.event, dedupeKey: key });
    return { key, deliveries };
  }
  for (const channel of ready) {
    const copy = renderCopy(channel.name, msg.event, prepared);
    if (!copy) continue;
    deliveries.set(channel.name, {
      event: msg.event,
      dedupeKey: key,
      recipient,
      copy,
      targetUrl: new URL(prepared.path, deps.origin).toString(),
      nextLive: prepared.nextLive,
    });
  }
  return { key, deliveries };
}
