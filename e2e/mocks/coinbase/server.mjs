#!/usr/bin/env node
// Mock Coinbase for the local stack and e2e (W5-B). It stands in for both Coinbase origins the API
// calls during personhood sign-in (apps/api/src/personhood/coinbase.ts):
//   login.coinbase.com  GET /oauth2/auth (approves at once and redirects), POST /oauth2/token
//   api.coinbase.com    GET /v2/user, GET /v2/user/personal-details
// The token endpoint checks the client credentials, the redirect URI and the PKCE S256 verifier,
// and each code works once. Response shapes match the API's parser and its unit-test fake
// (apps/api/test/personhood/fixtures.ts); /v2/user/personal-details is not publicly documented
// (launch gate 2), so its shape here is W5-B's assumption, recorded in docs/sessions/W5-B.md.
//
//   node e2e/mocks/coinbase/server.mjs            # listens on 127.0.0.1:8790
//   MOCK_COINBASE_PORT=9001 node e2e/mocks/coinbase/server.mjs
//
// Point the API at it in `.dev.vars` (the origin overrides are honoured only when ENVIRONMENT=local):
//   COINBASE_LOGIN_ORIGIN=http://127.0.0.1:8790
//   COINBASE_API_ORIGIN=http://127.0.0.1:8790
//   COINBASE_CLIENT_ID=mock-client-id
//   COINBASE_CLIENT_SECRET=mock-client-secret
//
// Endpoints besides Coinbase's:
//   GET  /health        {"ok": true}
//   GET  /mock/users    the built-in and added accounts
//   POST /mock/users    {"key": "x", "id"?: "...", "country"?: "US", "state"?: "NJ", "verified"?: true}
//                       → the account (verified: false = no personal details, i.e. not ID-verified)
// The authorize URL approves as the account named by `mock_user` (default `verified-us`), or
// declines with `mock_deny=1`: the test appends either to the URL the API returned.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_COINBASE_PORT ?? 8790);
const host = process.env.MOCK_COINBASE_HOST ?? '127.0.0.1';
const origin = `http://${host}:${port}`;
const clientId = process.env.MOCK_COINBASE_CLIENT_ID ?? 'mock-client-id';
const clientSecret = process.env.MOCK_COINBASE_CLIENT_SECRET ?? 'mock-client-secret';

/** A Coinbase account. `personal: null` = no personal details (not ID-verified). */
function account(key, { id, country = 'US', state = 'NJ', verified = true } = {}) {
  return {
    key,
    id: id ?? randomUUID(),
    name: `Mock ${key}`,
    email: `${key}@mock.coinbase.test`,
    personal: verified
      ? {
          legal_name: { first_name: 'Mock', last_name: key },
          address: {
            line1: '1 Mock Street',
            city: 'Mockville',
            state,
            postal_code: '00000',
            country_code: country,
          },
        }
      : null,
  };
}

const users = new Map(
  [
    account('verified-us', { country: 'US', state: 'NJ' }),
    account('verified-gb', { country: 'GB', state: 'LND' }),
    account('unverified', { verified: false }),
  ].map((u) => [u.key, u]),
);
const codes = new Map(); // code → { user, challenge, redirectUri }
const tokens = new Map(); // token → user

const s256 = (verifier) => createHash('sha256').update(verifier).digest('base64url');

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

function authorize(url, res) {
  const q = url.searchParams;
  const redirectUri = q.get('redirect_uri');
  if (q.get('response_type') !== 'code' || q.get('client_id') !== clientId || !redirectUri) {
    return json(res, 400, { error: 'invalid_request' });
  }
  const back = new URL(redirectUri);
  back.searchParams.set('state', q.get('state') ?? '');
  if (q.get('mock_deny') === '1') {
    back.searchParams.set('error', 'access_denied');
  } else {
    const user = users.get(q.get('mock_user') ?? 'verified-us');
    if (!user) return json(res, 400, { error: 'unknown mock_user' });
    const code = randomUUID();
    codes.set(code, { user, challenge: q.get('code_challenge') ?? '', redirectUri });
    back.searchParams.set('code', code);
  }
  res.writeHead(302, { location: back.toString() });
  res.end();
}

async function token(req, res) {
  const form = new URLSearchParams(await readBody(req));
  const code = form.get('code') ?? '';
  const entry = codes.get(code);
  codes.delete(code);
  const ok =
    entry &&
    form.get('grant_type') === 'authorization_code' &&
    form.get('client_id') === clientId &&
    form.get('client_secret') === clientSecret &&
    form.get('redirect_uri') === entry.redirectUri &&
    (!entry.challenge || s256(form.get('code_verifier') ?? '') === entry.challenge);
  if (!ok) return json(res, 400, { error: 'invalid_grant' });
  const accessToken = randomUUID();
  tokens.set(accessToken, entry.user);
  return json(res, 200, { access_token: accessToken, token_type: 'bearer', expires_in: 7200 });
}

function bearer(req) {
  return tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', origin);
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /health') return json(res, 200, { ok: true });
  if (route === 'GET /oauth2/auth') return authorize(url, res);
  if (route === 'POST /oauth2/token') {
    return void token(req, res).catch(() => json(res, 400, { error: 'invalid_request' }));
  }
  if (route === 'GET /v2/user' || route === 'GET /v2/user/personal-details') {
    const user = bearer(req);
    if (!user) return json(res, 401, { errors: [{ id: 'invalid_token' }] });
    if (url.pathname === '/v2/user') {
      return json(res, 200, {
        data: { id: user.id, name: user.name, email: user.email, resource: 'user' },
      });
    }
    if (!user.personal) return json(res, 404, { errors: [{ id: 'not_found' }] });
    return json(res, 200, { data: user.personal });
  }
  if (route === 'GET /mock/users') return json(res, 200, [...users.values()]);
  if (route === 'POST /mock/users') {
    return void readBody(req)
      .then((raw) => {
        const body = raw ? JSON.parse(raw) : {};
        if (typeof body.key !== 'string' || !body.key) {
          return json(res, 400, { error: 'key required' });
        }
        const user = account(body.key, body);
        users.set(user.key, user);
        return json(res, 200, user);
      })
      .catch(() => json(res, 400, { error: 'bad json' }));
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(port, host, () => {
  console.log(`mock coinbase listening on ${origin}`);
});
