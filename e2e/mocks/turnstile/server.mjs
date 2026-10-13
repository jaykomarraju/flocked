#!/usr/bin/env node
// Mock Turnstile siteverify for the local stack and e2e (W7-D; W3-Z carry-over). It stands in for
// https://challenges.cloudflare.com/turnstile/v0/siteverify, so no stack test calls Cloudflare. It
// keeps Cloudflare's documented test secrets' behaviour:
//   1x0000000000000000000000000000000AA  every token passes (the stack's secret, env.mjs)
//   2x0000000000000000000000000000000AA  every token fails (`invalid-input-response`)
//   3x0000000000000000000000000000000AA  every token is spent (`timeout-or-duplicate`)
// Any other secret answers `invalid-input-secret`, and a missing one or token the matching
// `missing-input-*` code, as siteverify does.
//
//   node e2e/mocks/turnstile/server.mjs            # listens on 127.0.0.1:8792
//   MOCK_TURNSTILE_PORT=9000 node e2e/mocks/turnstile/server.mjs
//
// Point the API at it in `.dev.vars` (honoured only when ENVIRONMENT=local; src/lib/turnstile.ts):
//   TURNSTILE_SITEVERIFY_URL=http://127.0.0.1:8792/turnstile/v0/siteverify
//
// Endpoints:
//   POST /turnstile/v0/siteverify  form or JSON {secret, response, remoteip?, idempotency_key?}
//   GET  /calls                    {"count": n}: siteverify calls so far (tests prove the stack uses it)
//   GET  /health                   {"ok": true}
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_TURNSTILE_PORT ?? 8792);
const host = process.env.MOCK_TURNSTILE_HOST ?? '127.0.0.1';
const origin = `http://${host}:${port}`;

const SECRETS = {
  '1x0000000000000000000000000000000AA': [],
  '2x0000000000000000000000000000000AA': ['invalid-input-response'],
  '3x0000000000000000000000000000000AA': ['timeout-or-duplicate'],
};

let calls = 0;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The request's fields: multipart or urlencoded form (as the API sends), or JSON. */
async function readFields(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const type = req.headers['content-type'] ?? '';
  if (type.startsWith('application/json')) return JSON.parse(body.toString('utf8') || '{}');
  const form = await new Response(body, { headers: { 'content-type': type } }).formData();
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
}

/** siteverify's answer for these fields. */
export function verdict({ secret, response }) {
  if (!secret) return ['missing-input-secret'];
  if (!response) return ['missing-input-response'];
  return SECRETS[secret] ?? ['invalid-input-secret'];
}

const server = createServer((req, res) => {
  const route = `${req.method} ${new URL(req.url ?? '/', origin).pathname}`;
  if (route === 'GET /health') return json(res, 200, { ok: true });
  if (route === 'GET /calls') return json(res, 200, { count: calls });
  if (route === 'POST /turnstile/v0/siteverify') {
    calls += 1;
    readFields(req)
      .then((fields) => {
        const errorCodes = verdict(fields);
        const ok = errorCodes.length === 0;
        return json(res, 200, {
          success: ok,
          'error-codes': errorCodes,
          ...(ok
            ? { challenge_ts: new Date().toISOString(), hostname: 'localhost', action: '' }
            : {}),
        });
      })
      .catch(() => json(res, 400, { success: false, 'error-codes': ['bad-request'] }));
    return undefined;
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(port, host, () => {
  console.log(`mock Turnstile siteverify on ${origin}`);
});
