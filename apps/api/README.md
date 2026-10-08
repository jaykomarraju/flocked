# @flocked/api

The API Worker: REST routes (Hono, under `/api/v1`), Durable Objects, cron triggers, queue
consumers and the D1 schema (spec "Architecture", "API", "Data model"). Wave 2 (P2.4) pins the
skeleton; later sessions fill in the stubs.

## Layout

```
wrangler.jsonc          bindings for local (top level), env.staging, env.production
migrations/0001_init.sql  every table, key, partial unique index, CHECK and index in "Data model"
src/index.ts            default { fetch, scheduled, queue } + the seven DO classes
src/app.ts              Hono app: error envelope, 404 envelope, /api/v1 mount
src/env.ts              Env (every binding, var and known secret)
src/routes/<module>.ts  one Hono sub-app per route module; index.ts mounts them
src/do/types.ts         pinned DO RPC interfaces (RoundDORpc, AnchorDORpc, …)
src/do/<name>-do.ts     DO classes (stubs until their owners land)
src/points/             atomic points movements (complete)
src/queues/index.ts     queue dispatch: logical name → schema → handler → ack/retry
src/cron.ts             cron expressions → jobs
src/lib/                errors, validate, log, clock, turnstile, alert, auth-context
test/                   Workers-runtime tests; test/helpers (seeded D1, sessions, fixed clock)
```

## Commands

```bash
pnpm --filter @flocked/api test        # vitest inside workerd (Miniflare)
pnpm --filter @flocked/api typecheck   # tsc (src, test, vitest.config.ts)
pnpm --filter @flocked/api lint
```

Migrations: number reserved per wave in `docs/plan/wave-N.md` (wave 3: `0002` W3-A, `0003` W3-B,
`0004` W3-D). Never edit an applied migration; add the next number.

## Tests

Every test runs in the Workers runtime through `@cloudflare/vitest-plugin`, using the real
`wrangler.jsonc` (top level = `local`). `test/setup.ts` applies `migrations/` to each test file's
fresh D1. Helpers in `test/helpers`:

- `seedFixture(env.DB)`: players (500 points from the signup grant), an admin, an open daily round
  with Free and Stakes modes locked with the launch defaults, a room with its owner.
- `withSession(subApp, fakeUser())` / `injectSession(user)`: stand-ins for W3-A's session
  middleware (`c.set('user')`, `c.set('session')`).
- `withFixedClock(env, ms)`: `ENVIRONMENT=local` plus `FLOCKED_TEST_CLOCK`, so `now(env)` is fixed.

Bindings in tests: D1, R2, KV, Durable Objects, Queues, Analytics Engine, `send_email` and the
assets Fetcher are Miniflare simulators. **AI and Vectorize** have no local simulator; with
`remoteBindings: false` they exist but throw when used, so code that needs them must take them
as injectable dependencies (fakes in tests). Real Turnstile is never called: `verifyTurnstile`
takes an injectable `fetch`. `test/worker.test.ts` checks `wrangler.jsonc` (all three
environments, parsed by wrangler) against the code: DO classes, crons, queues, decrypt settings.

`@openzeppelin/merkle-tree` (via `@flocked/settle`) is pre-bundled by Vite for workerd; when the
Worker starts importing `@flocked/tlock`, add tlock-js's deep imports to the same list (see
`packages/tlock/vitest.config.ts`).

## Conventions

- Errors: throw `HttpError(code, message)`; every response error is `{error: {code, message}}`
  with codes and statuses from `@flocked/shared` (`ERROR_CODES`, `ERROR_STATUS`).
- Validation: `validate('json' | 'query' | 'param', schema)`; read with `c.req.valid(...)`.
- Time: `now(env)` from `src/lib/clock.ts`, never `Date.now()` in game logic.
- Logs: `log.info/warn/error(event, data)`; `optionIndex`, `option_index`, `plaintext` and `nonce`
  are dropped at any depth unless `{ afterBeacon: true }`.
- Alerts: `raiseAlert(env, code, data)` with an `AlertCode` from `@flocked/shared`.
- Points: build with `stakeMovement` / `creditMovement` / `grantMovement` / `debitMovement`
  (`combineMovements` for paired rows) and run with `applyMovement`; never write
  `point_balances` or `points_ledger` any other way.
- DO RPC: expected rejections are `RpcResult` values (only an Error's message crosses RPC).

## Ownership of stubs

| Module or class                                                                        | Owner |
| -------------------------------------------------------------------------------------- | ----- |
| routes `auth`, `me` (profile, ToS); `AuthDO`, `RateLimitDO`; session middleware        | W3-A  |
| routes `entries`; `RoundDO` Free path and alarms                                       | W3-B  |
| `AnchorDO`, scheduler cron jobs                                                        | W4-A  |
| `IndexerDO`, indexer cron kick                                                         | W4-B  |
| `SettlementDO`, `settle` and `decrypt-*` queue handlers                                | W5-A  |
| `me` personhood endpoints                                                              | W5-B  |
| routes `stakes`                                                                        | W6-B  |
| routes `rounds`, `claims`                                                              | W6-D  |
| `RoundViewerDO`, `/rounds/:id/ws`                                                      | W7-A  |
| routes `limits`, `me` identities/merges/deletion                                       | W7-B  |
| routes `questions`                                                                     | W8-A  |
| routes `boards`, `users`, `me/referrals`                                               | W8-B  |
| routes `rooms`                                                                         | W8-D  |
| routes `push`, `notify` queue handler                                                  | W9-A  |
| routes `cards`, `cards` queue handler                                                  | W10-A |
| routes `paymaster`                                                                     | W10-D |
| routes `admin`                                                                         | W11-A |
| nightly points reconciliation (`src/jobs/reconcile.ts`, using `findBalanceMismatches`) | W5-D  |
