# W3-A handoff: API auth and sessions

## Status
complete: every W3-A route, both DOs, the session middleware and the required tests are in. `pnpm check` and `pnpm format:check` are green on Node 22.23.1. No `.2` session was needed.

## Summary
- **Sign-in** (`src/routes/auth.ts`, `src/auth/*`): SIWE through viem `verifySiweMessage`. It checks domain, URI origin, chain and validity window, and the nonce is consumed by `AuthDO` before the signature is checked. EOA signatures use ecrecover; ERC-1271 and ERC-6492 (undeployed Coinbase Smart Wallets) go through an injectable RPC client. Farcaster Quick Auth verifies the JWT with `jose` against Farcaster's JWKS (issuer `https://auth.farcaster.xyz`, audience = host of `APP_ORIGIN`, `sub` = FID). Email codes are 8 digits, hashed in KV with a 5-minute TTL, 5 attempts per code and 10 per hour per address, sent through `EmailSender`. Email signs in only: it never creates an account.
- **Accounts:** only SIWE or Farcaster can create one. Creation is a single D1 batch: the user (no handle yet), the identity, the 500-point `signup` grant through `grantMovement` (ref = user ID), and a pending `referrals` row when `ref` matches another active user. Turnstile is required on sign-up.
- **Sessions:** 256-bit random IDs; D1 stores only `sha256("session:"+token)`. The web gets an HttpOnly, SameSite=Lax cookie (`__Host-` + Secure outside local); the mini app gets a Bearer token. Lifetime is 30 days with no sliding renewal. `sessionMiddleware` runs on `/api/v1/*` and sets `user` and `session` per the wave-3 contract. A Bearer header wins and never falls back to the cookie. Suspended users still authenticate; merged and deleted users do not. Stale cookies are cleared.
- **DOs:** `AuthDO` is one instance per subject (`authDOFor(env, 'nonce'|'email'|'oauth', hash)`). It works under `blockConcurrencyWhile`, keeps use markers in its own storage, and an alarm deletes everything after expiry. OAuth bind/consume is ready for W5-B. `RateLimitDO` is one token bucket per key; its alarm deletes the state once the bucket is full again.
- **Rate limits** (`src/auth/rate-limit.ts`): `RATE_LIMITS` holds the spec's per-user buckets plus `authIp` (30/min, shared by the unauthenticated `/auth/*` endpoints, keyed by a SHA-256 of the IP) and `emailCodes`. Helpers: `enforce`, `limitAuthIp`, `limitUser(name)`.
- **`/me`:** `GET /me` returns profile, balances (global and member rooms), limits, `flags.needsHandle`, ToS, verification and Stakes eligibility (reasons computed; always at least `not_verified` until W5-B). `PATCH /me` handles handle (409 `handle_taken`), display name (NFC, trimmed, no control characters), card prefs and notification prefs. `POST /me/tos` accepts only `TOS_VERSION` and sets the age attestation. The other `me` rows still answer 501, in `ENDPOINTS` order.
- **`security_notice`** (`email_sign_in`) is enqueued on the notify queue on every email sign-in, validated with `NotifyMessageSchema`.
- **e2e mock:** `e2e/mocks/farcaster/server.mjs` is a dependency-free Node server that serves a JWKS and mints Quick Auth tokens (`POST /mint`). Smoke-tested by verifying its token with `jose`'s remote JWKS.

## Branch and head commit
`w3-a-auth` @ `5c11e59` (code). This handoff follows it.

## Files touched
- New: `apps/api/src/auth/{accounts,config,crypto,deps,email,farcaster,profile,rate-limit,session,siwe}.ts`, `apps/api/migrations/0002_auth.sql`, `apps/api/test/auth/fixtures.ts`, `apps/api/test/auth/{siwe,farcaster,session,email,rate-limit,auth-do,privacy,migration}.test.ts`, `apps/api/test/me/me.test.ts`, `e2e/mocks/farcaster/{server.mjs,README.md}`, `docs/sessions/W3-A.md`.
- Edited (owned): `apps/api/src/{app,env}.ts`, `apps/api/src/routes/{auth,me}.ts`, `apps/api/src/do/{auth-do,rate-limit-do}.ts`, `apps/api/test/helpers/auth.ts` (`realSession`), `apps/api/package.json` + `pnpm-lock.yaml` (`jose` 6.2.12, pinned exactly like the other deps).
- Edited (not owned, unavoidable; see Deviations): `apps/api/test/routes.test.ts`, `apps/api/test/do.test.ts`.

## Tests run
| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm check` | pass: node:test 20, abi 11, settle 66, tlock 161, shared 438, api 368 (was 281), forge 199 |
| `pnpm format:check` | pass |
| `node e2e/mocks/farcaster/server.mjs` + jose `createRemoteJWKSet` verify | pass (manual) |

## Traceability rows covered
- **ID-4** (W3-A): `test/auth/email.test.ts` › "ID-4 replay: a used code is refused", "ID-4 brute force: 5 attempts per code, then even the right code is refused", "ID-4 brute force: a new code resets the attempts, and the old code dies", "ID-4 brute force: concurrent guesses cannot exceed 5 attempts"; `test/auth/farcaster.test.ts` › "ID-4 Bearer flow: Quick Auth token → Bearer session → /me → logout → 401".
- **NFR-8** (W3-A part, IPs only within rate-limit windows): `test/auth/privacy.test.ts` › "no D1 table has an IP column", "no D1 row and no KV entry contains the client IP after every sign-in flow", "no session token, nonce or email code appears in D1 or KV"; `test/auth/rate-limit.test.ts` › "keys the bucket by a hash of the IP, never the IP", "enforces the bucket and drops its state when the alarm fires".
- Also required by the prompt: SIWE replay and wrong domain/chain (`siwe.test.ts` › "SIWE replay: …", "message checks › wrong domain / wrong URI origin / wrong chain / expired / not yet valid"); ERC-6492 and ERC-1271 (`siwe.test.ts` › "smart wallets"); account creation only via Farcaster or SIWE (`email.test.ts` › "account creation only via Farcaster or SIWE: …", plus the Turnstile tests in `siwe`/`farcaster`); rate limits (`rate-limit.test.ts`, `email.test.ts` › "about 10 codes per hour …").

## Deviations
- **`users.handle` made nullable (0002 rebuilds `users`).** 0001 had `handle NOT NULL`, but the pinned `SessionUserSchema`/`PublicUserSchema` say a new account has no handle until the user picks one, and the spec only says "handle (unique)". SQLite can't drop NOT NULL in place, so 0002 rebuilds the table with every other column, CHECK and index exactly as in 0001 (`test/auth/migration.test.ts` checks this). The considered alternative was generated handles plus a new `handle_set_at` column; it was rejected because `migrations.test.ts` treats extra columns as spec changes.
- **`test/routes.test.ts` (W2-D's):** the nine W3-A endpoints moved to an `IMPLEMENTED` set and are checked as mounted (not 404 or 501) instead of answering 501. Every other endpoint still has both 501 tests. Their behaviour is covered in `test/auth` and `test/me`.
- **`test/do.test.ts` (W2-D's):** the AuthDO and RateLimitDO "pins …" tests asserted `not_implemented`. They are replaced with one liveness call each through the binding.
- `AuthDO.bindOAuthState` on an already-bound state keeps the first binding and logs, instead of throwing. Throwing inside `blockConcurrencyWhile` resets the object, and an RPC rejection surfaced as an unhandled error in the test runner. Only a 256-bit state collision can reach this path.
- `GET /me` lists every Stakes reason it can compute (`age_unattested`, `tos_not_accepted`, `self_excluded`, `suspended`), not just `not_verified`.

## Spec issues
- **Data model › `users`:** state that `handle` is nullable until chosen (0002). Recommend a Decision log row. Reserved handles (`admin`, `flocked`, …) aren't specified; recommend a short blocklist, owned by W7-B or W8-B.
- **API › Rate limits:** the per-IP size for unauthenticated auth endpoints isn't given. W3-A chose 30/min per IP, shared across `/auth/*` (NAT-friendly). Recommend recording it.
- **Identity:** can a suspended account sign in? W3-A says yes (status `suspended` reaches routes, `/me` shows it, Stakes lists `suspended`), so the user can still see their account and claim. Recommend confirming, and that later write routes refuse `account_suspended`.
- **API › `/auth/email/start`:** Turnstile is optional in the schema. W3-A verifies it when present and doesn't require it. The 10/hour/address bucket applies to unlinked addresses too, so a 429 can't reveal linkage, and the send runs in `waitUntil`.

## Open issues
- KV is eventually consistent. A code or nonce written by the Worker might not be visible yet to an `AuthDO` in another colo, and the user would see "invalid". This was not observed (Miniflare is consistent); watch it in the W14 staging soak. The fix would be to write through the DO.
- Expired `sessions` rows are never purged. This needs a cron sweep (W13 ops, or whoever owns crons).
- A Quick Auth JWT can be exchanged for several sessions until its `exp` (about 1 h). Accepted: the token is as sensitive as the Bearer token it buys.
- The `send_email` builder form (`env.EMAIL.send({from,to,subject,text})`) is untested under `wrangler dev`. W3-D should try one email sign-in on the local stack. Production needs the sending domain verified (owner).
- `RateLimitDO` failures fail open (logged). Secret-guarding limits (5 attempts per code, single-use nonces) live in `AuthDO`.

## Notes for D and Z
- **wrangler.jsonc vars to add** (`src/env.ts` declares them optional; missing ones make the routes that need them answer 503):
  - `APP_ORIGIN`: local is the origin the web app runs on in the stack (e.g. `http://localhost:8787` if `wrangler dev` serves the assets, or Vite's `http://localhost:5173`); staging and production are owner-supplied, the same as the site's domain.
  - `TOS_VERSION`: e.g. `"2026-10-01"` everywhere until legal text exists (OA-21).
  - `EMAIL_FROM`: e.g. `codes@<domain>` per environment (owner verifies the domain).
  - `FARCASTER_AUTH_ORIGIN`: local only, in `.dev.vars` (`http://127.0.0.1:8789` for the mock). It's ignored outside local, so don't put it in staging or production.
- **Secrets used:** `TURNSTILE_SECRET_KEY` (already listed; locally use Turnstile's always-pass test secret in `.dev.vars`) and `BASE_RPC_URL`/`BASE_RPC_URL_FALLBACK` for smart-wallet SIWE (EOA sign-in works without them). Add the W3-A entries to the wrangler.jsonc secrets header.
- `test/routes.test.ts` `IMPLEMENTED` and `test/do.test.ts` will conflict trivially with W3-B's edits to the same files. Keep both sides.
- **Reuse:** W3-B/D apply `limitUser('entries')` on `POST /rounds/:id/entries` (10/min) if W3-B didn't. W5-B uses `authDOFor(env,'oauth',hash)`. W7-B uses `issueEmailCode`/`checkEmailCode`/`normalizeEmail` (`identities.external_id` for email = trimmed lowercase), `enqueueSecurityNotice(…,'identity_linked')`, `findAccount`. Test helper: `realSession(env, userId, 'cookie'|'bearer')` returns headers for the real middleware.
- `users.prefs_json` keys are `show_card_amounts`, `show_stakes_net`, `creator_payout_wallet` (snake_case, both shows default off).
- **Risky diffs worth reading:** `migrations/0002_auth.sql` (table rebuild), `src/auth/session.ts` (middleware), `src/do/auth-do.ts`.
- No `packages/shared` change is required. Optionally reword `SessionUserSchema.handle`'s comment ("null until the user picks one", for every new account, not only wallets).
