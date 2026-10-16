#!/usr/bin/env node
// Mock web push service for the local stack and e2e (W9-A). It stands in for the browsers' push
// services (FCM, Mozilla, Apple, WNS): a stack test subscribes with an endpoint on this server
// (`POST /push/subscribe` accepts loopback endpoints only when ENVIRONMENT=local) and its own P-256
// keys, then reads back what the notify consumer sent and decrypts it (RFC 8291) with those keys.
//
//   node e2e/mocks/push/server.mjs            # listens on 127.0.0.1:8794
//   MOCK_PUSH_PORT=9004 node e2e/mocks/push/server.mjs
//
// Endpoints:
//   POST /push/<id>            a push message: 201, or the status set for <id> (below); recorded
//   PUT  /status/<id>          body {"status": 410}: answer that status for <id> from now on
//   GET  /sent?id=<id>         {"messages": [{ id, headers, body (base64url), at }]} for <id> (all ids without it)
//   DELETE /sent               forget every recorded message and status
//   GET  /health               {"ok": true}
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_PUSH_PORT ?? 8794);
const host = process.env.MOCK_PUSH_HOST ?? '127.0.0.1';

/** @type {{ id: string, headers: Record<string, string>, body: string, at: number }[]} */
let messages = [];
/** @type {Map<string, number>} */
let statuses = new Map();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const PUSH_HEADERS = [
  'authorization',
  'content-encoding',
  'content-type',
  'ttl',
  'urgency',
  'topic',
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  const [, first, id] = url.pathname.split('/');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && first === 'push' && id) {
      const body = await readBody(req);
      const headers = Object.fromEntries(
        PUSH_HEADERS.filter((h) => req.headers[h] !== undefined).map((h) => [
          h,
          String(req.headers[h]),
        ]),
      );
      const status = statuses.get(id) ?? 201;
      if (status < 300)
        messages.push({ id, headers, body: body.toString('base64url'), at: Date.now() });
      res.writeHead(status);
      return res.end();
    }
    if (req.method === 'PUT' && first === 'status' && id) {
      const { status } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      statuses.set(id, Number(status));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/sent') {
      const want = url.searchParams.get('id');
      return json(res, 200, { messages: want ? messages.filter((m) => m.id === want) : messages });
    }
    if (req.method === 'DELETE' && url.pathname === '/sent') {
      messages = [];
      statuses = new Map();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, host, () => {
  console.log(`mock push service on http://${host}:${port}`);
});
