#!/usr/bin/env node
// Mock email sending for the local stack and e2e (W9-A). With ENVIRONMENT=local and EMAIL_MOCK_URL set,
// the notify consumer's email channel POSTs each email here instead of the `send_email` binding, so a
// stack test reads what was sent instead of wrangler's log (W8-C; W9-D's E2E-8).
//
//   node e2e/mocks/email/server.mjs            # listens on 127.0.0.1:8796
//   MOCK_EMAIL_PORT=9006 node e2e/mocks/email/server.mjs
//
// Point the API at it in `.dev.vars`:
//   EMAIL_MOCK_URL=http://127.0.0.1:8796
//
// Endpoints:
//   POST /send              an email {from, to, subject, text, html}; recorded
//   GET  /last?to=<addr>    the last email to <addr> (404 when none): {from, to, subject, text, html, at}
//   GET  /sent?to=<addr>    {"emails": [...]} to <addr> (all without it), oldest first
//   DELETE /sent            forget every recorded email
//   GET  /health            {"ok": true}
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_EMAIL_PORT ?? 8796);
const host = process.env.MOCK_EMAIL_HOST ?? '127.0.0.1';

let emails = [];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const norm = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /health') return json(res, 200, { ok: true });
    if (route === 'POST /send') {
      const email = await readJson(req);
      if (!email.to || !email.subject)
        return json(res, 400, { error: 'to and subject are required' });
      emails.push({ ...email, at: Date.now() });
      return json(res, 200, { ok: true });
    }
    if (route === 'GET /last') {
      const to = norm(url.searchParams.get('to'));
      const last = emails.filter((e) => norm(e.to) === to).at(-1);
      return last ? json(res, 200, last) : json(res, 404, { error: 'no email' });
    }
    if (route === 'GET /sent') {
      const to = url.searchParams.get('to');
      return json(res, 200, {
        emails: to ? emails.filter((e) => norm(e.to) === norm(to)) : emails,
      });
    }
    if (route === 'DELETE /sent') {
      emails = [];
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, host, () => {
  console.log(`mock email on http://${host}:${port}`);
});
