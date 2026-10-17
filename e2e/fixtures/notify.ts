// Notification channels for the e2e specs (W9-D), through W9-A's mocks on the stack: a web push
// subscription on the push mock (decrypted here as a browser would, RFC 8291), a Farcaster identity
// linked through the Quick Auth mock whose mini app notifications are turned on through the API's
// webhook (signed by the farcaster-notify mock), and a verified email whose notification emails the
// email mock records. Every notification read back carries its dedupe key: the push `tag`, or the
// Farcaster `notificationId` (the key without the user for per-user events).
import type { webcrypto } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR } from '../stack/env.mjs';
import { http } from './http';
import { poll, type Stack } from './stack';
import { auth, type User } from './user';

const te = new TextEncoder();
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, n: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: typeof info === 'string' ? te.encode(info) : info,
    },
    key,
    n * 8,
  );
  return new Uint8Array(bits);
}

function mocks(stack: Stack): NonNullable<Stack['notifyMocks']> {
  if (!stack.notifyMocks) {
    throw new Error(
      'the stack has no notification mocks: restart it (pnpm stack:down && stack:up)',
    );
  }
  return stack.notifyMocks;
}

/** What the service worker shows for a push (src/notify/channels/webpush.ts). */
export interface PushShown {
  title: string;
  body: string;
  url: string;
  /** The dedupe key. */
  tag: string;
}

/** A browser's push subscription on the push mock. */
export interface PushInbox {
  id: string;
  keys: webcrypto.CryptoKeyPair;
  pub: Uint8Array;
  auth: Uint8Array;
}

/** Subscribes `user` to web push with a fresh browser key pair, on the push mock. */
export async function subscribePush(stack: Stack, user: User): Promise<PushInbox> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const id = `u-${user.userId}`;
  const res = await stack.api('/push/subscribe', {
    ...auth(user),
    body: {
      endpoint: `${mocks(stack).push}/push/${id}`,
      keys: { p256dh: b64url(pub), auth: b64url(authSecret) },
    },
  });
  if (res.status !== 200)
    throw new Error(`push subscribe: ${res.status} ${JSON.stringify(res.body)}`);
  return { id, keys, pub, auth: authSecret };
}

/** Opens one aes128gcm push body (RFC 8291 §3.4, RFC 8188), as the browser does. */
async function openPush(inbox: PushInbox, body: Uint8Array): Promise<PushShown> {
  const salt = body.slice(0, 16);
  const idlen = body[20] ?? 0;
  const serverPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const serverKey = await crypto.subtle.importKey(
    'raw',
    serverPub,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, inbox.keys.privateKey, 256),
  );
  const ikm = await hkdf(
    inbox.auth,
    ecdh,
    cat(te.encode('WebPush: info\0'), inbox.pub, serverPub),
    32,
  );
  const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct),
  );
  // The last record ends with the 0x02 delimiter (no padding).
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1))) as PushShown;
}

/** Every push the mock received for this subscription, opened, oldest first. */
export async function pushes(stack: Stack, inbox: PushInbox): Promise<PushShown[]> {
  const res = await http<{ messages: { body: string }[] }>(
    `${mocks(stack).push}/sent?id=${encodeURIComponent(inbox.id)}`,
  );
  if (res.status !== 200) throw new Error(`push mock: ${res.status}`);
  return Promise.all(
    res.body.messages.map((m) => openPush(inbox, new Uint8Array(Buffer.from(m.body, 'base64url')))),
  );
}

/** A Farcaster mini app notification the mock's client endpoint received. */
export interface FarcasterSent {
  notificationId: string;
  title: string;
  body: string;
  targetUrl: string;
  tokens: string[];
}

/**
 * Links a Farcaster account (`fid`) to `user` with a Quick Auth token from the mock, then turns its
 * mini app notifications on: the farcaster-notify mock signs a `notifications_enabled` event, posted
 * to the API's webhook. Returns the notification token.
 */
export async function linkFarcaster(stack: Stack, user: User, fid: number): Promise<string> {
  const minted = await http<{ token: string }>(`${stack.farcasterUrl}/mint`, {
    body: { fid, domain: new URL(stack.appOrigin).host },
  });
  if (minted.status !== 200) throw new Error(`Quick Auth mint: ${minted.status}`);
  const linked = await stack.api('/me/identities/link', {
    ...auth(user),
    body: { provider: 'farcaster', token: minted.body.token },
  });
  if (linked.status !== 200) {
    throw new Error(`link Farcaster: ${linked.status} ${JSON.stringify(linked.body)}`);
  }
  const token = `tok-${fid}-${user.userId.slice(-6)}`;
  const signed = await http(`${mocks(stack).farcaster}/jfs`, {
    body: {
      fid,
      event: 'notifications_enabled',
      notificationDetails: { url: `${mocks(stack).farcaster}/notify/e2e`, token },
    },
  });
  if (signed.status !== 200) throw new Error(`JFS mock: ${signed.status}`);
  const hook = await stack.api('/farcaster/webhook', { body: signed.body, ip: user.ip });
  if (hook.status !== 200 || (hook.body as { result?: string }).result !== 'stored') {
    throw new Error(`Farcaster webhook: ${hook.status} ${JSON.stringify(hook.body)}`);
  }
  return token;
}

/** Every Farcaster notification sent to `token`, oldest first. */
export async function farcasterSent(stack: Stack, token: string): Promise<FarcasterSent[]> {
  const res = await http<{ notifications: FarcasterSent[] }>(
    `${mocks(stack).farcaster}/sent?token=${encodeURIComponent(token)}`,
  );
  if (res.status !== 200) throw new Error(`farcaster-notify mock: ${res.status}`);
  return res.body.notifications;
}

/** An email the email mock recorded. */
export interface EmailSent {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Every notification email to `address`, oldest first. */
export async function emailsTo(stack: Stack, address: string): Promise<EmailSent[]> {
  const res = await http<{ emails: EmailSent[] }>(
    `${mocks(stack).email}/sent?to=${encodeURIComponent(address)}`,
  );
  if (res.status !== 200) throw new Error(`email mock: ${res.status}`);
  return res.body.emails;
}

/** Where `wrangler dev` logs each email the send_email binding sends (sign-in codes). */
const WRANGLER_LOG = join(LOG_DIR, 'wrangler.log');
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function codeAfter(address: string, offset: number): string | null {
  const text = readFileSync(WRANGLER_LOG)
    .subarray(offset)
    .toString('utf8')
    .replace(ANSI_COLOUR, '');
  let to: string | null = null;
  let code: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const toLine = /^\s*To:\s*<?([^\s<>]+)>?\s*$/.exec(line);
    if (toLine) to = toLine[1]!.toLowerCase();
    const subject = /^\s*Subject:\s*(\d{8}) is your Flocked code\s*$/.exec(line);
    if (subject && to === address.toLowerCase()) code = subject[1]!;
  }
  return code;
}

/**
 * Adds and verifies an email on `user`'s account (`POST /me/email`, then the code from wrangler's
 * email log), so the email channel can reach it.
 */
export async function verifyEmail(stack: Stack, user: User, address: string): Promise<void> {
  const offset = statSync(WRANGLER_LOG).size;
  const added = await stack.api('/me/email', { ...auth(user), body: { email: address } });
  if (added.status !== 200)
    throw new Error(`POST /me/email: ${added.status} ${JSON.stringify(added.body)}`);
  const code = await poll(`a code for ${address}`, 30_000, () =>
    Promise.resolve(codeAfter(address, offset)),
  );
  const verified = await stack.api('/me/email/verify', {
    ...auth(user),
    body: { email: address, code },
  });
  if (verified.status !== 200) {
    throw new Error(`POST /me/email/verify: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
}
