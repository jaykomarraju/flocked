# Mock Coinbase

A stand-in for `https://login.coinbase.com` (OAuth 2.0) and `https://api.coinbase.com` (v2) in the
local stack and e2e tests. Personhood sign-in (`POST /api/v1/me/personhood`, then
`GET /api/v1/me/personhood/callback`) calls both; this one server answers for both origins.

```bash
node e2e/mocks/coinbase/server.mjs   # http://127.0.0.1:8790, MOCK_COINBASE_PORT to change
```

Point the API at it in `.dev.vars`. The origin overrides are honoured only when
`ENVIRONMENT=local`, so staging and production always call Coinbase.

```bash
COINBASE_LOGIN_ORIGIN=http://127.0.0.1:8790
COINBASE_API_ORIGIN=http://127.0.0.1:8790
COINBASE_CLIENT_ID=mock-client-id
COINBASE_CLIENT_SECRET=mock-client-secret
PERSON_ID_KEY=<openssl rand -hex 32>
```

The authorize URL the API returns approves at once and redirects to the API's callback with a
code. Append `mock_user=<key>` to choose the account (default `verified-us`), or `mock_deny=1` to
decline. Built-in accounts: `verified-us` (US, NJ), `verified-gb` (GB, LND) and `unverified` (no
personal details, which the API stores as not verified). Add more with
`POST /mock/users {"key": "...", "country": "FR", "state": "IDF", "verified": true}`.

The token endpoint checks the client credentials, the redirect URI and the PKCE (S256) verifier,
and each code works once. `/v2/user` answers `{ data: { id, name, email, ... } }` and
`/v2/user/personal-details` answers `{ data: { legal_name, address: { ..., state, country_code } } }`
(404 for `unverified`). The second shape is not publicly documented (launch gate 2); it is W5-B's
assumption, read only by `parsePersonalDetails` in `apps/api/src/personhood/coinbase.ts`.

Accounts get fresh random IDs at each start. Unit tests do not use this server:
`apps/api/test/personhood/fixtures.ts` has an in-process fake with the same shapes.
