// Web push (src/notify/channels/webpush.ts): the RFC 8291 payload decrypts with the subscription's
// private key, the RFC 8292 token verifies with the VAPID public key, and push service answers map
// to sent / gone / retry.
import { describe, expect, it } from 'vitest';
import {
  b64urlDecode,
  b64urlEncode,
  encryptPayload,
  webPushChannel,
  type VapidConfig,
} from '../../src/notify/channels/webpush.js';
import type { Delivery, Recipient } from '../../src/notify/types.js';

const te = new TextEncoder();
const bytes = (s: string) => new Uint8Array(te.encode(s));
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, n * 8),
  );
}

/** A browser's subscription keys. */
async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, pub, auth, p256dh: b64urlEncode(pub), authB64: b64urlEncode(auth) };
}

/** What the browser does with an aes128gcm push body (RFC 8291 §3.4, RFC 8188). */
async function decrypt(body: Uint8Array, ua: Awaited<ReturnType<typeof browserKeys>>) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20] ?? 0;
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey(
    'raw',
    asPub,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ua.pair.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(ua.auth, ecdh, cat(bytes('WebPush: info\0'), ua.pub, asPub), 32);
  const cek = await hkdf(salt, ikm, bytes('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, bytes('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct),
  );
  expect(plain[plain.length - 1]).toBe(2);
  return { rs, idlen, text: new TextDecoder().decode(plain.slice(0, -1)) };
}

async function vapidKeys(): Promise<VapidConfig> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return {
    publicKey: b64urlEncode(pub),
    privateKey: jwk.d ?? '',
    subject: 'mailto:ops@flocked.xyz',
  };
}

function recipient(
  subs: { id: string; endpoint: string; p256dh: string; auth: string }[],
): Recipient {
  return {
    userId: 'u',
    excluded: false,
    email: null,
    pushSubscriptions: subs,
    farcasterTokens: [],
    prefs: new Map(),
  };
}

const delivery = (r: Recipient): Delivery<'webpush'> => ({
  event: 'question_live',
  dedupeKey: 'question_live:r:u',
  recipient: r,
  copy: { title: "Today's question is live", body: 'Pineapple on pizza?' },
  targetUrl: 'https://flocked.xyz/',
});

describe('encryptPayload (RFC 8291)', () => {
  it('decrypts with the subscription private key and auth secret', async () => {
    const ua = await browserKeys();
    const body = await encryptPayload(bytes('{"hello":"flock"}'), ua.p256dh, ua.authB64);
    const out = await decrypt(body, ua);
    expect(out).toEqual({ rs: 4096, idlen: 65, text: '{"hello":"flock"}' });
  });

  it('a different auth secret does not decrypt', async () => {
    const ua = await browserKeys();
    const body = await encryptPayload(bytes('x'), ua.p256dh, ua.authB64);
    await expect(decrypt(body, { ...ua, auth: new Uint8Array(16) })).rejects.toThrow();
  });
});

describe('webPushChannel', () => {
  it('POSTs an encrypted payload with a VAPID token that verifies for the push service origin', async () => {
    const vapid = await vapidKeys();
    const ua = await browserKeys();
    const calls: { url: string; init: RequestInit }[] = [];
    const ch = webPushChannel(vapid, {
      fetch: (url, init) => {
        calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
        return Promise.resolve(new Response(null, { status: 201 }));
      },
      now: () => Date.UTC(2026, 9, 9),
      dropSubscription: () => Promise.resolve(),
    });
    const r = recipient([
      {
        id: 's1',
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        p256dh: ua.p256dh,
        auth: ua.authB64,
      },
    ]);
    expect(ch.available(r)).toBe(true);
    expect(await ch.send([delivery(r)])).toEqual({ retry: [] });
    const call = calls[0];
    if (!call) throw new Error('no call');
    const headers = new Headers(call.init.headers);
    expect(headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(headers.get('TTL')).toBe('86400');
    const { text } = await decrypt(new Uint8Array(call.init.body as ArrayBuffer), ua);
    expect(JSON.parse(text)).toEqual({
      title: "Today's question is live",
      body: 'Pineapple on pizza?',
      url: 'https://flocked.xyz/',
      tag: 'question_live:r:u',
    });
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(
      headers.get('Authorization') ?? '',
    );
    if (!m) throw new Error('bad Authorization');
    const [, h, c, s, k] = m as unknown as [string, string, string, string, string];
    expect(k).toBe(vapid.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c))) as Record<string, unknown>;
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Date.UTC(2026, 9, 9) / 1000 + 12 * 3600,
      sub: 'mailto:ops@flocked.xyz',
    });
    const pub = await crypto.subtle.importKey(
      'raw',
      b64urlDecode(k),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pub,
        b64urlDecode(s),
        bytes(`${h}.${c}`),
      ),
    ).toBe(true);
  });

  it('drops a gone subscription, retries only when no device took it and one failed transiently', async () => {
    const vapid = await vapidKeys();
    const ua = await browserKeys();
    const status: Record<string, number> = {};
    const dropped: string[] = [];
    const ch = webPushChannel(vapid, {
      fetch: (url) =>
        Promise.resolve(
          new Response(null, {
            status: status[url instanceof Request ? url.url : url.toString()] ?? 201,
          }),
        ),
      now: () => 0,
      dropSubscription: (id) => {
        dropped.push(id);
        return Promise.resolve();
      },
    });
    const sub = (id: string) => ({
      id,
      endpoint: `https://push.services.mozilla.com/${id}`,
      p256dh: ua.p256dh,
      auth: ua.authB64,
    });
    status['https://push.services.mozilla.com/a'] = 410;
    status['https://push.services.mozilla.com/b'] = 503;
    expect(await ch.send([delivery(recipient([sub('a'), sub('b')]))])).toEqual({
      retry: ['question_live:r:u'],
    });
    expect(dropped).toEqual(['a']);
    expect(await ch.send([delivery(recipient([sub('b'), sub('c')]))])).toEqual({ retry: [] });
    status['https://push.services.mozilla.com/d'] = 400;
    expect(await ch.send([delivery(recipient([sub('d')]))])).toEqual({ retry: [] });
  });
});
