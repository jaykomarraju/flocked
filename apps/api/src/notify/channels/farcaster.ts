// Farcaster mini app notifications (spec "Notifications"; the Farcaster mini app notification API). Each
// token was stored from the mini app's webhook (farcaster-webhook.ts) with its client's endpoint `url`.
// Sends are batched: deliveries with the same endpoint, notification ID, title, body and target URL
// go out as one POST of up to 100 tokens, as the API allows. The answer lists tokens by result:
//   * successfulTokens → sent;
//   * invalidTokens    → the token is disabled (the user removed the app or turned notifications off);
//   * rateLimitedTokens → transient (each token gets 1 notification per 30 s and 100 a day): the
//     message is retried after the queue's retry delay (30 s).
// A non-2xx answer counts as transient for 429 and 5xx, and as refused (logged) otherwise. A delivery
// is retried only when none of its tokens took it and one failed transiently, so a user with the app
// in two clients never gets a repeat on the one that worked. The notification ID is also the
// client's own dedupe key (per FID, 24 h), a second guard against repeats.
import { log } from '../../lib/log.js';
import type { Channel, Delivery, FarcasterTarget, SendOutcome } from '../types.js';

/** The API's limits: tokens per request, and the notification ID's length. */
export const FARCASTER_LIMITS = { tokens: 100, notificationId: 128 } as const;

export interface FarcasterDeps {
  fetch: typeof fetch;
  /** Disables tokens the client reported invalid. */
  disableTokens: (tokens: readonly { url: string; token: string }[]) => Promise<void>;
}

/** Events whose dedupe key ends in the user's ID; their notification ID drops it, so users batch. */
const PER_USER_SUFFIX = new Set([
  'question_live',
  'closing_soon',
  'streak_at_risk',
  'outcome',
  'refunded',
  'payout_claimable',
]);

/**
 * The notification ID for a delivery: its dedupe key, without the trailing user ID for the events
 * keyed `…:{userId}`, so the same notification to many users shares one ID (and one request). The
 * client dedupes per FID, so a shared ID never hides one user's notification from another.
 */
export function notificationIdFor(d: Pick<Delivery, 'event' | 'dedupeKey'>): string {
  let id = d.dedupeKey;
  if (PER_USER_SUFFIX.has(d.event)) {
    const cut = id.lastIndexOf(':');
    if (cut > 0) id = id.slice(0, cut);
  }
  return id.slice(0, FARCASTER_LIMITS.notificationId);
}

interface SendResponse {
  result?: {
    successfulTokens?: string[];
    invalidTokens?: string[];
    rateLimitedTokens?: string[];
  };
}

type TokenResult = 'sent' | 'invalid' | 'transient' | 'refused';

interface Group {
  url: string;
  body: { notificationId: string; title: string; body: string; targetUrl: string };
  tokens: Set<string>;
}

/** The Farcaster channel. */
export function farcasterChannel(deps: FarcasterDeps): Channel<'farcaster'> {
  async function post(group: Group, tokens: string[]): Promise<Map<string, TokenResult>> {
    const out = new Map<string, TokenResult>();
    const all = (r: TokenResult) => {
      for (const t of tokens) out.set(t, r);
      return out;
    };
    let res: Response;
    try {
      res = await deps.fetch(group.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...group.body, tokens }),
      });
    } catch (err) {
      log.warn('farcaster_notify_error', {
        url: group.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return all('transient');
    }
    if (res.status === 429 || res.status >= 500) return all('transient');
    if (!res.ok) {
      log.warn('farcaster_notify_refused', { url: group.url, status: res.status });
      return all('refused');
    }
    const json = await res.json<SendResponse>().catch((): SendResponse => ({}));
    for (const t of json.result?.successfulTokens ?? []) out.set(t, 'sent');
    for (const t of json.result?.invalidTokens ?? []) out.set(t, 'invalid');
    for (const t of json.result?.rateLimitedTokens ?? []) out.set(t, 'transient');
    // A token the answer doesn't mention wasn't accepted: try it again.
    for (const t of tokens) if (!out.has(t)) out.set(t, 'transient');
    return out;
  }

  return {
    name: 'farcaster',
    available: (r) => r.farcasterTokens.length > 0,
    async send(batch: readonly Delivery<'farcaster'>[]): Promise<SendOutcome> {
      const groups = new Map<string, Group>();
      const groupOf = (d: Delivery<'farcaster'>, t: FarcasterTarget) => {
        const body = {
          notificationId: notificationIdFor(d),
          title: d.copy.title,
          body: d.copy.body,
          targetUrl: d.targetUrl,
        };
        const k = JSON.stringify([
          t.url,
          body.notificationId,
          body.title,
          body.body,
          body.targetUrl,
        ]);
        if (!groups.has(k)) groups.set(k, { url: t.url, body, tokens: new Set() });
        return k;
      };
      const perDelivery = batch.map((d) =>
        d.recipient.farcasterTokens.map((t) => {
          const k = groupOf(d, t);
          groups.get(k)?.tokens.add(t.token);
          return { group: k, url: t.url, token: t.token };
        }),
      );

      const results = new Map<string, TokenResult>();
      for (const [k, g] of groups) {
        const tokens = [...g.tokens];
        for (let i = 0; i < tokens.length; i += FARCASTER_LIMITS.tokens) {
          const r = await post(g, tokens.slice(i, i + FARCASTER_LIMITS.tokens));
          for (const [t, v] of r) results.set(`${k}\n${t}`, v);
        }
      }

      const invalid: { url: string; token: string }[] = [];
      const retry: string[] = [];
      for (const [i, d] of batch.entries()) {
        const own = (perDelivery[i] ?? []).map((x) => {
          const r = results.get(`${x.group}\n${x.token}`) ?? 'transient';
          if (r === 'invalid') invalid.push({ url: x.url, token: x.token });
          return r;
        });
        if (!own.includes('sent') && own.includes('transient')) retry.push(d.dedupeKey);
      }
      if (invalid.length > 0) await deps.disableTokens(invalid);
      return { retry };
    },
  };
}
