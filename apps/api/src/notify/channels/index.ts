// The channels a deployment can send on, from its configuration. A channel whose configuration is
// missing is absent (and logged once per batch by the consumer), never replaced by a mock: local runs
// point the real channels at the e2e mocks (e2e/mocks/{push,farcaster-notify,email}).
import type { Env } from '../../env.js';
import type { ChannelSet } from '../types.js';
import { webPushChannel } from './webpush.js';

/** Vars this module reads that src/env.ts doesn't declare yet (W9-D adds them; "Notes for D"). */
export type NotifyVars = {
  /** Uncompressed P-256 public key, base64url (scripts/gen-vapid.mjs). Public: the web app needs it too. */
  VAPID_PUBLIC_KEY?: string;
  /** RFC 8292 contact, e.g. `mailto:ops@flocked.xyz`. */
  VAPID_SUBJECT?: string;
};

export type NotifyEnv = Env & NotifyVars;

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
  return set;
}
