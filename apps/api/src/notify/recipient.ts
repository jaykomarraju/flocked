// Resolves a notify message's user to a Recipient: the account (following a merge), whether it is
// self-excluded, its notification prefs and every place it can be reached. Spec "Notifications",
// "Data model" (`notification_prefs`, `push_subscriptions`, `limits`), "Identity and personhood".
import type { NotificationChannel, NotificationEvent } from '@flocked/shared';
import { excludedSql } from '../limits/rules.js';
import type { FarcasterTarget, PushTarget, Recipient } from './types.js';

/** Events that are off until the user turns them on (spec "Notifications", Default column). */
const DEFAULT_OFF: ReadonlySet<NotificationEvent> = new Set(['streak_at_risk']);

/** A merge chain longer than this is a data error; the message is dropped. */
const MAX_MERGE_HOPS = 4;

/**
 * Whether `event` is on for `channel`: a stored pref wins, else the event's default. Security
 * notices are always on and ignore prefs.
 */
export function prefEnabled(
  recipient: Pick<Recipient, 'prefs'>,
  channel: NotificationChannel,
  event: NotificationEvent,
): boolean {
  if (event === 'security_notice') return true;
  return recipient.prefs.get(`${channel}:${event}`) ?? !DEFAULT_OFF.has(event);
}

interface UserRow {
  id: string;
  status: string;
  merged_into: string | null;
}

/**
 * The recipient for `userId` at `t`, or null when there is no one to notify (no such user, a
 * deleted account, or a merge chain that ends nowhere).
 */
export async function loadRecipient(
  db: D1Database,
  userId: string,
  t: number,
): Promise<Recipient | null> {
  let id = userId;
  let user: UserRow | null = null;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    user = await db
      .prepare('SELECT id, status, merged_into FROM users WHERE id = ?1')
      .bind(id)
      .first<UserRow>();
    if (!user || user.status !== 'merged') break;
    if (!user.merged_into) return null;
    id = user.merged_into;
  }
  if (!user || user.status === 'deleted' || user.status === 'merged') return null;

  const [excluded, email, push, tokens, prefs] = await db.batch([
    db.prepare(`SELECT ${excludedSql('?1', '?2')} AS excluded`).bind(id, t),
    db
      .prepare(
        `SELECT external_id FROM identities
         WHERE user_id = ?1 AND provider = 'email' AND verified_at IS NOT NULL
         ORDER BY verified_at DESC LIMIT 1`,
      )
      .bind(id),
    db
      .prepare('SELECT id, endpoint, keys_json FROM push_subscriptions WHERE user_id = ?1')
      .bind(id),
    db
      .prepare(
        `SELECT t.fid, t.app_fid, t.url, t.token FROM farcaster_notification_tokens t
         JOIN identities i ON i.provider = 'farcaster' AND i.external_id = CAST(t.fid AS TEXT)
         WHERE i.user_id = ?1 AND t.enabled = 1`,
      )
      .bind(id),
    db
      .prepare('SELECT channel, event, enabled FROM notification_prefs WHERE user_id = ?1')
      .bind(id),
  ]);

  const pushSubscriptions: PushTarget[] = [];
  for (const row of (push?.results ?? []) as {
    id: string;
    endpoint: string;
    keys_json: string;
  }[]) {
    const keys = JSON.parse(row.keys_json) as { p256dh?: unknown; auth?: unknown };
    if (typeof keys.p256dh === 'string' && typeof keys.auth === 'string') {
      pushSubscriptions.push({
        id: row.id,
        endpoint: row.endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      });
    }
  }
  const farcasterTokens: FarcasterTarget[] = (
    (tokens?.results ?? []) as { fid: number; app_fid: number; url: string; token: string }[]
  ).map((r) => ({ fid: r.fid, appFid: r.app_fid, url: r.url, token: r.token }));
  const prefMap = new Map<string, boolean>();
  for (const r of (prefs?.results ?? []) as { channel: string; event: string; enabled: number }[]) {
    prefMap.set(`${r.channel}:${r.event}`, r.enabled === 1);
  }
  const excludedRow = excluded?.results[0] as { excluded: number } | undefined;
  const emailRow = email?.results[0] as { external_id: string } | undefined;
  return {
    userId: id,
    excluded: excludedRow?.excluded === 1,
    email: emailRow?.external_id ?? null,
    pushSubscriptions,
    farcasterTokens,
    prefs: prefMap,
  };
}
