# Mock Farcaster Quick Auth

A stand-in for `https://auth.farcaster.xyz` in the local stack and e2e tests. The mini app's
sign-in (`POST /api/v1/auth/farcaster`) verifies a Quick Auth JWT against the issuer's JWKS; this
server publishes its own JWKS and mints tokens with the same claims (issuer = its origin, audience
= the app's domain, subject = the FID).

```bash
node e2e/mocks/farcaster/server.mjs   # http://127.0.0.1:8789, MOCK_FARCASTER_PORT to change
```

Point the API at it in `apps/api/.dev.vars`. The override is honoured only when
`ENVIRONMENT=local`, so staging and production always use Farcaster's server.

```bash
FARCASTER_AUTH_ORIGIN=http://127.0.0.1:8789
APP_ORIGIN=http://localhost:5173
```

Mint a token for FID 123 and exchange it for a Bearer session (the first sign-in creates the
account, so it also needs a Turnstile token; use Turnstile's always-pass test keys locally):

```bash
TOKEN=$(curl -s localhost:8789/mint -d '{"fid":123,"domain":"localhost:5173"}' | jq -r .token)
curl -s localhost:8787/api/v1/auth/farcaster -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"turnstileToken\":\"XXXX.DUMMY.TOKEN.XXXX\"}"
```

The key pair is generated at each start and never stored. Unit tests do not use this server:
`apps/api/test/auth/fixtures.ts` signs tokens with an in-memory key.
