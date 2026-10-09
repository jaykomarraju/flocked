#!/usr/bin/env node
// Mock Farcaster Quick Auth server for the local stack and e2e (W3-A). It stands in for
// https://auth.farcaster.xyz: it serves a JWKS and mints RS256 tokens shaped like Quick Auth's
// (iss = this server's origin, aud = the app's domain, sub = the FID). A fresh key pair is
// generated at every start and never written to disk.
//
//   node e2e/mocks/farcaster/server.mjs            # listens on 127.0.0.1:8789
//   MOCK_FARCASTER_PORT=9000 node e2e/mocks/farcaster/server.mjs
//
// Point the API at it in `apps/api/.dev.vars` (honoured only when ENVIRONMENT=local):
//   FARCASTER_AUTH_ORIGIN=http://127.0.0.1:8789
//
// Endpoints:
//   GET  /.well-known/jwks.json  the public key
//   POST /mint                   {"fid": 123, "domain": "localhost:5173", "ttlSec"?: 3600}
//                                → {"token": "<jwt>"}
//   GET  /health                 {"ok": true}
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const port = Number(process.env.MOCK_FARCASTER_PORT ?? 8789);
const host = process.env.MOCK_FARCASTER_HOST ?? '127.0.0.1';
const origin = `http://${host}:${port}`;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomUUID();
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] };

const b64url = (value) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** A Quick Auth-shaped JWT for `fid`, audience `domain`. */
export function mint(fid, domain, ttlSec = 3600) {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT', kid });
  const payload = b64url({ iss: origin, sub: String(fid), aud: domain, iat, exp: iat + ttlSec });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = createServer((req, res) => {
  const route = `${req.method} ${new URL(req.url ?? '/', origin).pathname}`;
  if (route === 'GET /.well-known/jwks.json') return json(res, 200, jwks);
  if (route === 'GET /health') return json(res, 200, { ok: true });
  if (route === 'POST /mint') {
    readJson(req)
      .then(({ fid, domain, ttlSec }) => {
        if (!/^[1-9][0-9]{0,15}$/.test(String(fid)) || typeof domain !== 'string' || !domain) {
          return json(res, 400, {
            error: 'expected {"fid": <positive integer>, "domain": "<host>"}',
          });
        }
        return json(res, 200, { token: mint(fid, domain, Number(ttlSec ?? 3600)) });
      })
      .catch(() => json(res, 400, { error: 'invalid JSON' }));
    return undefined;
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(port, host, () => {
  console.log(`mock Farcaster Quick Auth on ${origin} (kid ${kid})`);
});
