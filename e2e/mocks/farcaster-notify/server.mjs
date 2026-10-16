#!/usr/bin/env node
// Mock Farcaster services for notifications (W9-A): a client's mini app notification endpoint, the hub
// lookup the webhook uses to check app keys, Neynar's cast API for the daily cast, and a signer that
// builds webhook events, so a stack test never reaches Farcaster.
//
//   node e2e/mocks/farcaster-notify/server.mjs            # listens on 127.0.0.1:8795
//   MOCK_FARCASTER_NOTIFY_PORT=9005 node e2e/mocks/farcaster-notify/server.mjs
//
// Point the API at it in `.dev.vars` (the cast override is honoured only when ENVIRONMENT=local):
//   FARCASTER_HUB_URL=http://127.0.0.1:8795
//   FARCASTER_CAST_API_URL=http://127.0.0.1:8795
//   NEYNAR_API_KEY=mock-neynar-key
//   FARCASTER_CAST_SIGNER_UUID=mock-signer
//
// Endpoints:
//   POST /notify/<client>          a notification send ({notificationId, title, body, targetUrl, tokens}).
//                                  Tokens starting "invalid-" come back invalid, "ratelimited-" rate
//                                  limited, the rest successful; recorded
//   GET  /sent?token=<t>           {"notifications": [...]} sent to token <t> (all without it)
//   POST /jfs                      {"fid": 123, "event": "notifications_enabled", "notificationDetails"?:
//                                  {"url", "token"}} → a signed webhook body {header, payload, signature}
//                                  from this mock's app key (valid for any FID on the hub below)
//   GET  /v1/onChainSignersByFid   ?fid=&signer=: an active signer (ADD) for the mock's app key, whose
//                                  metadata names app FID MOCK_APP_FID (default 9152); 404 for any other key
//   GET  /v1/verificationsByFid    {"messages": []} (wallet offers: nothing to offer)
//   POST /v2/farcaster/cast        Neynar's cast API; repeats of an `idem` key are not recorded twice
//   GET  /casts                    {"casts": [...]}
//   DELETE /sent                   forget every recorded notification and cast
//   GET  /health                   {"ok": true}
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { encodeAbiParameters } from 'viem';

const port = Number(process.env.MOCK_FARCASTER_NOTIFY_PORT ?? 8795);
const host = process.env.MOCK_FARCASTER_NOTIFY_HOST ?? '127.0.0.1';
const appFid = BigInt(process.env.MOCK_APP_FID ?? 9152);

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const appKey = `0x${Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')}`;
const metadata = Buffer.from(
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
        requestFid: appFid,
        requestSigner: '0x0000000000000000000000000000000000000001',
        signature: '0x',
        deadline: 0n,
      },
    ],
  ).slice(2),
  'hex',
).toString('base64');

let notifications = [];
let casts = [];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const b64url = (s) => Buffer.from(s).toString('base64url');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname.startsWith('/notify/')) {
      const body = await readJson(req);
      const tokens = Array.isArray(body.tokens) ? body.tokens : [];
      if (tokens.length > 100) return json(res, 400, { error: 'too many tokens' });
      const result = { successfulTokens: [], invalidTokens: [], rateLimitedTokens: [] };
      for (const t of tokens) {
        if (t.startsWith('invalid-')) result.invalidTokens.push(t);
        else if (t.startsWith('ratelimited-')) result.rateLimitedTokens.push(t);
        else result.successfulTokens.push(t);
      }
      notifications.push({ path: url.pathname, ...body, result, at: Date.now() });
      return json(res, 200, { result });
    }
    if (route === 'GET /sent') {
      const token = url.searchParams.get('token');
      return json(res, 200, {
        notifications: token
          ? notifications.filter((n) => n.tokens.includes(token))
          : notifications,
      });
    }
    if (route === 'POST /jfs') {
      const { fid, event, notificationDetails } = await readJson(req);
      const header = b64url(JSON.stringify({ fid, type: 'app_key', key: appKey }));
      const payload = b64url(
        JSON.stringify(notificationDetails ? { event, notificationDetails } : { event }),
      );
      const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString(
        'base64url',
      );
      return json(res, 200, { header, payload, signature });
    }
    if (route === 'GET /v1/onChainSignersByFid') {
      const signer = (url.searchParams.get('signer') ?? '').toLowerCase();
      const fid = Number(url.searchParams.get('fid'));
      if (signer !== appKey) return json(res, 404, { errCode: 'not_found' });
      return json(res, 200, {
        type: 'EVENT_TYPE_SIGNER',
        chainId: 10,
        blockNumber: 1,
        fid,
        signerEventBody: {
          key: appKey,
          keyType: 1,
          eventType: 'SIGNER_EVENT_TYPE_ADD',
          metadata,
          metadataType: 1,
        },
      });
    }
    if (route === 'GET /v1/verificationsByFid') return json(res, 200, { messages: [] });
    if (route === 'POST /v2/farcaster/cast') {
      const body = await readJson(req);
      if (!req.headers['x-api-key']) return json(res, 401, { message: 'no api key' });
      const repeat = body.idem && casts.some((c) => c.idem === body.idem);
      if (!repeat) casts.push({ ...body, at: Date.now() });
      return json(res, 200, { success: true, cast: { hash: `0x${casts.length.toString(16)}` } });
    }
    if (route === 'GET /casts') return json(res, 200, { casts });
    if (route === 'DELETE /sent') {
      notifications = [];
      casts = [];
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, host, () => {
  console.log(`mock farcaster notifications on http://${host}:${port} (app key ${appKey})`);
});
