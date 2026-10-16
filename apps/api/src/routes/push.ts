// Route module `push`: web push subscriptions (spec "Notifications", "Data model" › push_subscriptions).
// Owner: W9-A. `POST /push/subscribe` stores the browser's subscription. The endpoint is unique: a
// browser that re-subscribes (for this user or, after a sign-in switch, another) moves the row to the
// caller with the new keys (W2-Z). It stays open to suspended accounts: it is a notification setting,
// which decision B7 keeps editable. The consumer POSTs to the stored endpoint, so only the browsers'
// push services are accepted (and, locally, the e2e push mock on loopback).
import { PushSubscribeRequestSchema, newUlid, type PushSubscribeResponse } from '@flocked/shared';
import { Hono } from 'hono';
import { limitUser } from '../auth/rate-limit.js';
import type { Env } from '../env.js';
import { getUser, requireUser, type AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';

/** Hosts of the browsers' push services (Chrome/Edge via FCM, Firefox, Safari, Windows). */
const PUSH_SERVICE_SUFFIXES = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
] as const;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether the consumer may POST to `endpoint`. */
export function pushEndpointAllowed(endpoint: string, env: Pick<Env, 'ENVIRONMENT'>): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (env.ENVIRONMENT === 'local' && LOOPBACK.has(url.hostname)) return true;
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export const push = new Hono<AppEnv>();

push.post(
  '/push/subscribe',
  requireUser,
  limitUser('writes'),
  validate('json', PushSubscribeRequestSchema),
  async (c) => {
    const user = getUser(c);
    const { endpoint, keys } = c.req.valid('json');
    if (!pushEndpointAllowed(endpoint, c.env)) {
      throw new HttpError('bad_request', 'Not a push service endpoint');
    }
    const row = await c.env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, keys_json) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json
       RETURNING id`,
    )
      .bind(
        newUlid(now(c.env)),
        user.id,
        endpoint,
        JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth }),
      )
      .first<{ id: string }>();
    if (!row) throw new HttpError('internal', 'Subscription not stored');
    return c.json({ id: row.id } satisfies PushSubscribeResponse);
  },
);
