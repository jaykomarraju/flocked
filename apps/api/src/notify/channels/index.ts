// The channels a deployment can send on, from its configuration. A channel whose configuration is
// missing is absent (and logged by the consumer), never replaced by a mock: local runs point the real
// channels at the e2e mocks (e2e/mocks/{push,farcaster-notify,email}) through overrides honoured only
// when ENVIRONMENT is 'local'.
//   * webpush: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (a secret) and VAPID_SUBJECT;
//   * farcaster: always on; each token carries its client's endpoint (stored from verified webhook
//     events, https only outside local);
//   * email: the `EMAIL` binding and a sender (NOTIFY_EMAIL_FROM, else EMAIL_FROM); locally,
//     EMAIL_MOCK_URL sends to the e2e email mock instead, so a stack test can read what was sent.
import type { Env } from '../../env.js';
import type { ChannelSet } from '../types.js';
import { emailChannel, type OutgoingEmail } from './email.js';
import { farcasterChannel } from './farcaster.js';
import { webPushChannel } from './webpush.js';

/** Vars this module reads that src/env.ts doesn't declare yet (W9-D adds them; "Notes for D"). */
export type NotifyVars = {
  /** Uncompressed P-256 public key, base64url (scripts/gen-vapid.mjs). Public: the web app needs it too. */
  VAPID_PUBLIC_KEY?: string;
  /** RFC 8292 contact, e.g. `mailto:ops@flocked.xyz`. */
  VAPID_SUBJECT?: string;
  /** Sender of notification emails, e.g. `hello@flocked.xyz`; defaults to EMAIL_FROM. */
  NOTIFY_EMAIL_FROM?: string;
  /** The e2e email mock's origin (e2e/mocks/email); honoured only when ENVIRONMENT is 'local'. */
  EMAIL_MOCK_URL?: string;
};

export type NotifyEnv = Env & NotifyVars;

/** Sends through the e2e email mock (local only). */
function mockEmailSender(origin: string) {
  return async (email: OutgoingEmail) => {
    const res = await fetch(new URL('/send', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(email),
    });
    if (!res.ok) throw new Error(`email mock answered ${res.status}`);
  };
}

/** The configured channels for `env`. */
export function channelsFor(env: NotifyEnv, now: () => number): ChannelSet {
  const set: { -readonly [K in keyof ChannelSet]: ChannelSet[K] } = {};
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    set.webpush = webPushChannel(
      {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
      },
      {
        fetch: (input, init) => fetch(input, init),
        now,
        dropSubscription: async (id) => {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?1').bind(id).run();
        },
      },
    );
  }
  set.farcaster = farcasterChannel({
    fetch: (input, init) => fetch(input, init),
    disableTokens: async (tokens) => {
      const t = now();
      await env.DB.batch(
        tokens.map((x) =>
          env.DB.prepare(
            'UPDATE farcaster_notification_tokens SET enabled = 0, updated_at = ?3 WHERE url = ?1 AND token = ?2',
          ).bind(x.url, x.token, t),
        ),
      );
    },
  });
  const from = env.NOTIFY_EMAIL_FROM || env.EMAIL_FROM;
  if (from) {
    const mock = env.ENVIRONMENT === 'local' ? env.EMAIL_MOCK_URL : undefined;
    set.email = emailChannel({
      from,
      send: mock ? mockEmailSender(mock) : (email) => env.EMAIL.send(email),
    });
  }
  return set;
}
