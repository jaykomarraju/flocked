// Web push (spec "Notifications"): VAPID (RFC 8292) and the aes128gcm payload encryption of RFC 8291,
// with WebCrypto only. Each delivery goes to every subscription of the recipient:
//   * 201/202 → sent;
//   * 404/410 → the subscription is gone: its row is deleted;
//   * 429, 5xx or a network error → transient;
//   * any other status → refused (logged, not retried).
// A delivery is retried only when no subscription took it and one failed transiently, so a retry
// never repeats a notification a device already showed. The payload is JSON the web app's service
// worker shows: { title, body, url, tag } (tag = the dedupe key, so a repeat replaces, not stacks).
import { log } from '../../lib/log.js';
import type { Channel, Delivery, PushTarget, SendOutcome } from '../types.js';

export interface VapidConfig {
  /** The uncompressed P-256 public key (65 bytes), base64url: the browser's applicationServerKey. */
  publicKey: string;
  /** The private scalar d (32 bytes), base64url. */
  privateKey: string;
  /** `mailto:` or `https:` contact for push services (RFC 8292 `sub`). */
  subject: string;
}

export interface WebPushDeps {
  fetch: typeof fetch;
  /** Epoch ms, for the VAPID token's expiry. */
  now: () => number;
  /** Deletes a subscription the push service says is gone. */
  dropSubscription: (id: string) => Promise<void>;
}

/** Seconds a push service keeps an undelivered message. */
const TTL_SECONDS = 24 * 3600;
/** VAPID tokens may live at most 24 h (RFC 8292); 12 h leaves room for clock skew. */
const VAPID_TTL_SECONDS = 12 * 3600;
/** RFC 8188 record size; one record holds any payload we send. */
const RECORD_SIZE = 4096;

const te = new TextEncoder();
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(te.encode(s));

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** Optional fixed inputs, for tests only. */
export interface EncryptOverrides {
  salt?: Uint8Array<ArrayBuffer>;
  senderKeys?: CryptoKeyPair;
}

/** RFC 8291: encrypts `plaintext` for a subscription's keys (`aes128gcm` content coding). */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
  overrides: EncryptOverrides = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  const sender =
    overrides.senderKeys ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair);
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', sender.publicKey)) as ArrayBuffer,
  );
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workers-types spells the ECDH `public` member `$public`; the runtime reads `public`.
      { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      sender.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(authSecret, ecdh, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the plaintext, then the last-record delimiter 0x02 and no padding.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      concat(plaintext, new Uint8Array([2])),
    ),
  );
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function signingKey(config: VapidConfig): Promise<CryptoKey> {
  const pub = b64urlDecode(config.publicKey);
  if (pub.length !== 65 || pub[0] !== 4)
    throw new Error('VAPID_PUBLIC_KEY is not an uncompressed P-256 key');
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64urlEncode(pub.slice(1, 33)),
      y: b64urlEncode(pub.slice(33, 65)),
      d: config.privateKey,
      ext: false,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** RFC 8292: the `Authorization` header value for a push service's origin. */
export async function vapidAuthorization(
  config: VapidConfig,
  key: CryptoKey,
  endpoint: string,
  nowMs: number,
): Promise<string> {
  const enc = (o: unknown) => b64urlEncode(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + VAPID_TTL_SECONDS,
    sub: config.subject,
  })}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${config.publicKey}`;
}

type TargetResult = 'sent' | 'gone' | 'transient' | 'refused';

/** The web push channel. */
export function webPushChannel(config: VapidConfig, deps: WebPushDeps): Channel<'webpush'> {
  let key: Promise<CryptoKey> | null = null;
  const keyOnce = () => (key ??= signingKey(config));

  async function sendOne(
    target: PushTarget,
    body: Uint8Array<ArrayBuffer>,
    urgency: string,
  ): Promise<TargetResult> {
    try {
      const payload = await encryptPayload(body, target.p256dh, target.auth);
      const res = await deps.fetch(target.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidAuthorization(
            config,
            await keyOnce(),
            target.endpoint,
            deps.now(),
          ),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(TTL_SECONDS),
          Urgency: urgency,
        },
        body: payload,
      });
      if (res.status === 201 || res.status === 202 || res.status === 200) return 'sent';
      if (res.status === 404 || res.status === 410) return 'gone';
      if (res.status === 429 || res.status >= 500) return 'transient';
      log.warn('webpush_refused', { subscriptionId: target.id, status: res.status });
      return 'refused';
    } catch (err) {
      log.warn('webpush_error', {
        subscriptionId: target.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'transient';
    }
  }

  return {
    name: 'webpush',
    available: (r) => r.pushSubscriptions.length > 0,
    async send(batch: readonly Delivery<'webpush'>[]): Promise<SendOutcome> {
      const retry: string[] = [];
      for (const d of batch) {
        const body = utf8(JSON.stringify({ ...d.copy, url: d.targetUrl, tag: d.dedupeKey }));
        const urgency = d.event === 'security_notice' ? 'high' : 'normal';
        const results = await Promise.all(
          d.recipient.pushSubscriptions.map((t) => sendOne(t, body, urgency)),
        );
        for (const [i, r] of results.entries()) {
          const target = d.recipient.pushSubscriptions[i];
          if (r === 'gone' && target) await deps.dropSubscription(target.id);
        }
        if (!results.includes('sent') && results.includes('transient')) retry.push(d.dedupeKey);
      }
      return { retry };
    },
  };
}
