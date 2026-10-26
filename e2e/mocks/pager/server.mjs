#!/usr/bin/env node
// Local guardian paging sink for the independent watcher (PIPE-5).
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_PAGER_PORT ?? 8799);
const host = process.env.MOCK_PAGER_HOST ?? '127.0.0.1';
let pages = [];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /health') return json(res, 200, { ok: true });
    if (route === 'POST /page') {
      pages.push({ ...(await readJson(req)), at: Date.now() });
      return json(res, 200, { ok: true });
    }
    if (route === 'GET /sent') return json(res, 200, { pages });
    if (route === 'DELETE /sent') {
      pages = [];
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, host, () => console.log(`mock pager on http://${host}:${port}`));
