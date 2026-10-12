# Mock Turnstile siteverify

A stand-in for `https://challenges.cloudflare.com/turnstile/v0/siteverify` in the local stack (W7-D), so no
stack test or Playwright spec calls Cloudflare. It answers as Cloudflare's documented test secrets do:
`1x0000000000000000000000000000000AA` (the stack's secret) passes every token, `2x…AA` fails every token and
`3x…AA` reports it spent. Any other secret is `invalid-input-secret`.

```bash
node e2e/mocks/turnstile/server.mjs   # http://127.0.0.1:8792, MOCK_TURNSTILE_PORT to change
```

`pnpm stack:up` starts it and writes `TURNSTILE_SITEVERIFY_URL` into `e2e/stack/.dev.vars`. The API honours that
override only when `ENVIRONMENT=local` (`apps/api/src/lib/turnstile.ts`), so staging and production always call
Cloudflare. `GET /calls` counts siteverify calls, so a test can check the stack used the mock.
