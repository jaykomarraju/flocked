// The Farcaster mini app webhook (src/notify/farcaster-webhook.ts): a signed event from an active app
// key stores, re-enables or disables the user's token per client; anything else is refused.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Hex } from 'viem';
import { b64urlEncode } from '../../src/notify/channels/webpush.js';
import {
  appFidOf,
  farcasterWebhook,
  handleFarcasterEvent,
  hubAppKeyVerifier,
  type VerifyAppKey,
} from '../../src/notify/farcaster-webhook.js';
import { withSession } from '../helpers/index.js';
import { T } from './helpers.js';

const te = new TextEncoder();
let keys: CryptoKeyPair;
let appKey: Hex;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  appKey = `0x${Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('')}`;
});

async function jfs(fid: number, payload: object, key: Hex = appKey, signer = keys.privateKey) {
  const header = b64urlEncode(te.encode(JSON.stringify({ fid, type: 'app_key', key })));
  const body = b64urlEncode(te.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, signer, te.encode(`${header}.${body}`)),
  );
  return { header, payload: body, signature: b64urlEncode(sig) };
}

const valid: VerifyAppKey = (_fid, key) =>
  Promise.resolve({ valid: key === appKey, appFid: key === appKey ? 9152 : null });
const prod = { DB: env.DB, ENVIRONMENT: 'production' as const };
const details = { url: 'https://api.farcaster.xyz/v1/frame-notifications', token: 'tok-1' };
const row = (fid: number) =>
  env.DB.prepare(
    'SELECT app_fid, url, token, enabled FROM farcaster_notification_tokens WHERE fid = ?1',
  )
    .bind(fid)
    .first();

describe('handleFarcasterEvent', () => {
  it('stores a token on notifications_enabled, disables it on removal, and re-enables it with a new token', async () => {
    expect(
      await handleFarcasterEvent(
        prod,
        await jfs(77, { event: 'notifications_enabled', notificationDetails: details }),
        valid,
        T,
      ),
    ).toBe('stored');
    expect(await row(77)).toEqual({ app_fid: 9152, url: details.url, token: 'tok-1', enabled: 1 });
    expect(
      await handleFarcasterEvent(prod, await jfs(77, { event: 'miniapp_removed' }), valid, T),
    ).toBe('disabled');
    expect(await row(77)).toMatchObject({ enabled: 0 });
    await handleFarcasterEvent(
      prod,
      await jfs(77, { event: 'frame_added', notificationDetails: { ...details, token: 'tok-2' } }),
      valid,
      T,
    );
    expect(await row(77)).toMatchObject({ token: 'tok-2', enabled: 1 });
    expect(
      await handleFarcasterEvent(prod, await jfs(77, { event: 'miniapp_added' }), valid, T),
    ).toBe('ignored');
    await handleFarcasterEvent(prod, await jfs(77, { event: 'notifications_disabled' }), valid, T);
    expect(await row(77)).toMatchObject({ enabled: 0 });
  });

  it('refuses a bad signature, a key that is not an active signer, a malformed body and a non-https URL', async () => {
    const event = await jfs(78, { event: 'notifications_enabled', notificationDetails: details });
    const tampered = {
      ...event,
      payload: b64urlEncode(
        te.encode(
          JSON.stringify({
            event: 'notifications_enabled',
            notificationDetails: { ...details, url: 'https://evil.example/x' },
          }),
        ),
      ),
    };
    await expect(handleFarcasterEvent(prod, tampered, valid, T)).rejects.toMatchObject({
      code: 'invalid_signature',
    });
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const otherRaw = new Uint8Array(
      (await crypto.subtle.exportKey('raw', other.publicKey)) as ArrayBuffer,
    );
    const otherKey: Hex = `0x${Array.from(otherRaw, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    await expect(
      handleFarcasterEvent(
        prod,
        await jfs(
          78,
          { event: 'notifications_enabled', notificationDetails: details },
          otherKey,
          other.privateKey,
        ),
        valid,
        T,
      ),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(handleFarcasterEvent(prod, { header: 'x' }, valid, T)).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(
      handleFarcasterEvent(
        prod,
        await jfs(78, {
          event: 'notifications_enabled',
          notificationDetails: { ...details, url: 'http://127.0.0.1:8795/notify/x' },
        }),
        valid,
        T,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(await row(78)).toBeNull();
    // Locally the e2e mock's loopback endpoint is accepted.
    await handleFarcasterEvent(
      { DB: env.DB, ENVIRONMENT: 'local' },
      await jfs(78, {
        event: 'notifications_enabled',
        notificationDetails: { ...details, url: 'http://127.0.0.1:8795/notify/x' },
      }),
      valid,
      T,
    );
    expect(await row(78)).toMatchObject({ url: 'http://127.0.0.1:8795/notify/x' });
  });

  it('a hub that cannot answer is 503, so the client retries', async () => {
    const down: VerifyAppKey = () => Promise.reject(new Error('hub down'));
    await expect(
      handleFarcasterEvent(
        prod,
        await jfs(79, { event: 'notifications_enabled', notificationDetails: details }),
        down,
        T,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('hubAppKeyVerifier', () => {
  const metadata = (requestFid: bigint) =>
    btoa(
      String.fromCharCode(
        ...Array.from(
          encodeAbiParameters(
            [
              {
                type: 'tuple',
                components: [
                  { name: 'requestFid', type: 'uint256' },
                  { name: 'requestSigner', type: 'address' },
                  { name: 'signature', type: 'bytes' },
                  { name: 'deadline', type: 'uint256' },
                ],
              },
            ],
            [
              {
                requestFid,
                requestSigner: '0x0000000000000000000000000000000000000001',
                signature: '0x',
                deadline: 0n,
              },
            ],
          )
            .slice(2)
            .match(/../g) ?? [],
          (h) => parseInt(h, 16),
        ),
      ),
    );

  it('reads the app FID from an ADD event, refuses a removed or unknown key', async () => {
    const answers: Record<string, Response> = {};
    const fetchFn = ((u: URL) =>
      Promise.resolve(
        answers[u.searchParams.get('signer') ?? ''] ?? new Response('{}', { status: 404 }),
      )) as unknown as typeof fetch;
    answers['0xaa'] = Response.json({
      blockNumber: 5,
      signerEventBody: {
        key: '0xaa',
        eventType: 'SIGNER_EVENT_TYPE_ADD',
        metadata: metadata(309857n),
      },
    });
    answers['0xbb'] = Response.json({
      events: [
        {
          blockNumber: 5,
          signerEventBody: {
            key: '0xbb',
            eventType: 'SIGNER_EVENT_TYPE_ADD',
            metadata: metadata(1n),
          },
        },
        { blockNumber: 9, signerEventBody: { key: '0xbb', eventType: 'SIGNER_EVENT_TYPE_REMOVE' } },
      ],
    });
    const verify = hubAppKeyVerifier('https://hub.example', fetchFn);
    expect(await verify(1, '0xaa')).toEqual({ valid: true, appFid: 309857 });
    expect(await verify(1, '0xbb')).toEqual({ valid: false, appFid: null });
    expect(await verify(1, '0xcc')).toEqual({ valid: false, appFid: null });
    expect(appFidOf('not base64 abi')).toBeNull();
  });
});

describe('POST /farcaster/webhook', () => {
  it('answers 503 when no hub is configured', async () => {
    const app = withSession(farcasterWebhook);
    const res = await app.request(
      '/farcaster/webhook',
      { method: 'POST', body: JSON.stringify(await jfs(80, { event: 'miniapp_removed' })) },
      { ...env, FARCASTER_HUB_URL: '' },
    );
    expect(res.status).toBe(503);
  });
});
