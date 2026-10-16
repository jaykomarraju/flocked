// The Farcaster mini app webhook (the manifest's `webhookUrl`): stores notification tokens from the
// client's signed events (spec "Notifications": Farcaster mini app notifications). Each event is a
// JSON Farcaster Signature `{ header, payload, signature }` (base64url):
//   * header  `{ fid, type: "app_key", key }`: the user's FID and the app key (Ed25519) that signed;
//   * payload `{ event, notificationDetails? }`: `miniapp_added` (with details when notifications are
//     on), `notifications_enabled` (details), `miniapp_removed`, `notifications_disabled`; the older
//     `frame_added` / `frame_removed` names are accepted too;
//   * signature: Ed25519 over `${header}.${payload}`.
// The key must be an active signer of the FID onchain, checked on a Farcaster hub
// (`GET /v1/onChainSignersByFid?fid=&signer=`), whose SignedKeyRequest metadata names the client app's
// FID: tokens are stored per (fid, app_fid). Without FARCASTER_HUB_URL nothing can be verified and the
// route answers 503. W9-D mounts `farcasterWebhook` and adds its ENDPOINTS row ("Notes for D").
import { Hono } from 'hono';
import { decodeAbiParameters, type Hex } from 'viem';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { b64urlDecode } from './channels/webpush.js';

/** The webhook route's path (registered by W9-D). */
export const FARCASTER_WEBHOOK_PATH = '/farcaster/webhook';

const JfsSchema = z.object({
  header: z.string().min(1).max(4096),
  payload: z.string().min(1).max(4096),
  signature: z.string().min(1).max(256),
});

const HeaderSchema = z.object({
  fid: z.int().positive(),
  type: z.literal('app_key'),
  key: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const DetailsSchema = z.object({
  url: z.url().max(1024),
  token: z.string().min(1).max(512),
});

const PayloadSchema = z.object({
  event: z.enum([
    'miniapp_added',
    'frame_added',
    'miniapp_removed',
    'frame_removed',
    'notifications_enabled',
    'notifications_disabled',
  ]),
  notificationDetails: DetailsSchema.optional(),
});

export interface AppKeyCheck {
  valid: boolean;
  /** The client app's FID (the signer's SignedKeyRequest `requestFid`). */
  appFid: number | null;
}

export type VerifyAppKey = (fid: number, key: Hex) => Promise<AppKeyCheck>;

const SIGNED_KEY_REQUEST = [
  {
    type: 'tuple',
    components: [
      { name: 'requestFid', type: 'uint256' },
      { name: 'requestSigner', type: 'address' },
      { name: 'signature', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
] as const;

/** The app FID in a signer's SignedKeyRequest metadata (base64 ABI bytes), or null. */
export function appFidOf(metadataB64: string): number | null {
  try {
    const bytes = Uint8Array.from(atob(metadataB64), (c) => c.charCodeAt(0));
    const hex: Hex = `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const [req] = decodeAbiParameters(SIGNED_KEY_REQUEST, hex);
    const fid = Number(req.requestFid);
    return Number.isSafeInteger(fid) && fid > 0 ? fid : null;
  } catch {
    return null;
  }
}

interface SignerEvent {
  blockNumber?: number;
  signerEventBody?: { key?: string; eventType?: string; metadata?: string };
}

/** Checks an app key on a Farcaster hub's HTTP API. Throws when the hub can't answer. */
export function hubAppKeyVerifier(hubUrl: string, fetchFn: typeof fetch = fetch): VerifyAppKey {
  return async (fid, key) => {
    const url = new URL('/v1/onChainSignersByFid', hubUrl);
    url.searchParams.set('fid', String(fid));
    url.searchParams.set('signer', key);
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (res.status === 404 || res.status === 400) return { valid: false, appFid: null };
    if (!res.ok) throw new Error(`hub answered ${res.status}`);
    const json = await res.json<SignerEvent & { events?: SignerEvent[] }>();
    const events = (json.events ?? [json]).filter(
      (e) => e.signerEventBody?.key?.toLowerCase() === key.toLowerCase(),
    );
    const latest = events.sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0))[0];
    const body = latest?.signerEventBody;
    if (body?.eventType !== 'SIGNER_EVENT_TYPE_ADD') return { valid: false, appFid: null };
    return { valid: true, appFid: body.metadata ? appFidOf(body.metadata) : null };
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A client notification endpoint we may POST to: https, or loopback locally (the e2e mock). */
export function notificationUrlAllowed(url: string, env: Pick<Env, 'ENVIRONMENT'>): boolean {
  const u = new URL(url);
  if (env.ENVIRONMENT === 'local' && LOOPBACK.has(u.hostname)) return true;
  return u.protocol === 'https:' && !u.username && !u.password;
}

async function verifySignature(jfs: z.infer<typeof JfsSchema>, key: Hex): Promise<boolean> {
  try {
    const raw = Uint8Array.from(key.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16));
    const pub = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      pub,
      b64urlDecode(jfs.signature),
      new TextEncoder().encode(`${jfs.header}.${jfs.payload}`),
    );
  } catch {
    return false;
  }
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
  } catch {
    return null;
  }
}

export type WebhookResult = 'stored' | 'disabled' | 'ignored';

/** Verifies one webhook event and applies it to `farcaster_notification_tokens`. */
export async function handleFarcasterEvent(
  env: Pick<Env, 'DB' | 'ENVIRONMENT'>,
  body: unknown,
  verifyAppKey: VerifyAppKey,
  t: number,
): Promise<WebhookResult> {
  const jfs = JfsSchema.safeParse(body);
  if (!jfs.success) throw new HttpError('bad_request', 'Not a JSON Farcaster Signature');
  const header = HeaderSchema.safeParse(decodeJson(jfs.data.header));
  const payload = PayloadSchema.safeParse(decodeJson(jfs.data.payload));
  if (!header.success || !payload.success) {
    throw new HttpError('bad_request', 'Unknown webhook header or event');
  }
  const { fid, key } = header.data;
  if (!(await verifySignature(jfs.data, key as Hex))) {
    throw new HttpError('invalid_signature', 'The event signature does not verify');
  }
  let check: AppKeyCheck;
  try {
    check = await verifyAppKey(fid, key as Hex);
  } catch (err) {
    log.warn('farcaster_webhook_hub_error', {
      fid,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new HttpError('unavailable', 'The app key could not be checked; try again');
  }
  if (!check.valid || check.appFid === null) {
    throw new HttpError('invalid_signature', 'The app key is not an active signer of this FID');
  }
  const appFid = check.appFid;
  const { event, notificationDetails: details } = payload.data;
  const db = env.DB;
  const on =
    event === 'notifications_enabled' || event === 'miniapp_added' || event === 'frame_added';
  if (on && details) {
    if (!notificationUrlAllowed(details.url, env)) {
      throw new HttpError('bad_request', 'The notification URL must be https');
    }
    await db
      .prepare(
        `INSERT INTO farcaster_notification_tokens (fid, app_fid, url, token, enabled, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5)
         ON CONFLICT (fid, app_fid) DO UPDATE SET url = excluded.url, token = excluded.token,
           enabled = 1, updated_at = excluded.updated_at`,
      )
      .bind(fid, appFid, details.url, details.token, t)
      .run();
    log.info('farcaster_token_stored', { fid, appFid, event });
    return 'stored';
  }
  if (on) return 'ignored';
  await db
    .prepare(
      'UPDATE farcaster_notification_tokens SET enabled = 0, updated_at = ?3 WHERE fid = ?1 AND app_fid = ?2',
    )
    .bind(fid, appFid, t)
    .run();
  log.info('farcaster_token_disabled', { fid, appFid, event });
  return 'disabled';
}

/** `POST /farcaster/webhook`: no session; the signature is the authentication. */
export const farcasterWebhook = new Hono<AppEnv>();

farcasterWebhook.post(FARCASTER_WEBHOOK_PATH, async (c) => {
  const hub = c.env.FARCASTER_HUB_URL;
  if (!hub) throw new HttpError('unavailable', 'Farcaster notifications are not configured');
  const body: unknown = await c.req.json().catch(() => null);
  const result = await handleFarcasterEvent(c.env, body, hubAppKeyVerifier(hub), now(c.env));
  return c.json({ ok: true, result });
});
