# Session W3-A: API auth and sessions

**Role:** build. **Size:** M (split into `W3-A.2` if needed: SIWE, sessions and `/me` first; Farcaster, email codes and rate limits second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-3.md`: the intro, "Pinned interfaces", "W3-A" and "Changes from W2-Z".
- `docs/sessions/W2-Z.md` (wave-2 summary). Then `docs/plan/wave-2.md` "P2.4" and its "As built (W2-Z)" note.
- Code you build on: `packages/shared/src/api/{auth,me,errors}.ts`, `packages/shared/src/api/index.ts` (`ENDPOINTS`), `apps/api/src/{app,env}.ts`, `apps/api/src/lib/{auth-context,validate,turnstile,clock,log,errors}.ts`, `apps/api/src/do/types.ts` (`AuthDO`, `RateLimitDO`), `apps/api/src/points/index.ts` (`grantMovement`), `apps/api/src/routes/stub.ts`, `apps/api/test/helpers/`.
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "API"                        # rows /auth/*, /me, /me/tos, and "Rate limits"
  pnpm spec "Identity and personhood" --sub "Identities"
  pnpm spec "Data model"                 # rows users, identities, sessions, point_balances, points_ledger; the SIWE nonce paragraph
  pnpm spec "Anti-abuse"                 # the Turnstile bullet only
  pnpm spec "Modes: Free and Stakes"     # the Starting balance row only
  ```
  Changed in wave 2 (Decision log, Oct 8, 2026): "API" (handle rule `^[a-z0-9_-]{3,20}$`, paymaster row, site-root share routes) and "Data model" (time units, `audit_log.actor_user_id`).

## Objective
Sign-in and sessions work. Implement the auth endpoints (SIWE with EIP-1271/6492 smart-wallet signatures, Farcaster Quick Auth, email codes that can link but never create an account), cookie and Bearer sessions with hashed IDs, `AuthDO` and `RateLimitDO`, the session middleware, `GET /me` (profile, balances, limits, flags; Stakes eligibility is `ineligible: not_verified` until W5-B), `PATCH /me` (handle, display name), `POST /me/tos`, `POST /auth/logout`, the signup grant through `src/points/`, and Turnstile on signup.

## Starting point
- Base: tag `wave-2`. Branch: `w3-a-auth`. Worktree: `../flocked-w3-a`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w3-a -b w3-a-auth wave-2
  cd ../flocked-w3-a && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit: `apps/api/src/routes/{auth,me}.ts`, `apps/api/src/auth/**`, `apps/api/src/do/{auth-do,rate-limit-do}.ts`, `apps/api/src/app.ts` (the session middleware, mounted before `/api/v1`), `apps/api/src/env.ts` (W3-A owns it this wave; W3-B lists its needs for D), `apps/api/test/helpers/auth.ts`, `apps/api/migrations/0002_auth.sql`, `apps/api/test/auth/**`, `apps/api/test/me/**`, `e2e/mocks/farcaster/**`, `docs/sessions/W3-A.md`. `pnpm-lock.yaml` only through `pnpm add` in `apps/api`.
- Must not touch: other route modules, `apps/api/src/do/round-do.ts`, `apps/api/src/{index.ts,routes/index.ts}`, `apps/api/wrangler.jsonc`, `packages/shared/**` (pinned; record needed changes for D), `apps/api/src/points/**`, root `package.json`, `.github/workflows/*`, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P2.4 (`docs/plan/wave-2.md`) as built: the `/auth/*` and `/me*` rows of `ENDPOINTS` and their schemas; `validate()`; `requireUser`/`optionalUser`; `raiseAlert(env, code, data)`; `grantMovement` (signup grant: reason `signup`, ref = user ID). Routes replace `stubEndpoints(...)` in their module and keep `ENDPOINTS` order.
- Wave 3 "Session middleware contract": `c.set('user', { id, status, role, personId, kycStatus })` and `c.set('session', { idHash, kind: 'cookie' | 'bearer' })`.
- `AuthDO`: `consumeNonce`, `consumeEmailCode`, `bindOAuthState`, `consumeOAuthState`. `RateLimitDO`: `take(bucket, cost)` (`apps/api/src/do/types.ts`).

## Tasks
1. Create the worktree (above).
2. Sessions and middleware: random session IDs stored hashed; cookie (web) and Bearer (mini app); logout; the middleware in `src/app.ts`; `test/helpers/auth.ts` gains real-session injection.
3. SIWE with viem `verifySiweMessage`: nonce from `AuthDO` (single use), domain and chain checks, EIP-1271 and ERC-6492 (undeployed Coinbase Smart Wallets) through an RPC client that tests can mock.
4. Farcaster Quick Auth: verify the JWT against Farcaster's JWKS; a local mock JWKS in `e2e/mocks/farcaster`.
5. Email codes: 8 digits, hashed in KV with a 5-minute TTL, 5 attempts per code, about 10 codes per hour per address, sent through an `EmailSender` interface. Email can link, never create.
6. `RateLimitDO` buckets per user and per IP (IPs not persisted beyond the window); `/me`, `PATCH /me`, `POST /me/tos`; signup grant; Turnstile on signup (`lib/turnstile.ts`); enqueue `security_notice` on the notify queue (W9-A sends it).

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required: ID-4 (brute force, replay, Bearer flow); SIWE replay, wrong domain and wrong chain; account creation only via Farcaster or SIWE; rate limits; NFR-8 part (assert no IP column writes). Name each test in the handoff with its traceability ID.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Every route above validates with the P2.4 schemas and answers per the spec; ID-4 has named, passing tests; `0002_auth.sql` applies on top of `0001`; the handoff is written.

## Constraints
- Never commit secrets; tests generate keys and write local values to `.dev.vars`. New vars or secrets: add them to `src/env.ts` and list the `wrangler.jsonc` changes under "Notes for D".
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, follow plan.md 2.6 (`W3-A.2`).

## End of session
1. Commit, then `git push -u origin w3-a-auth`.
2. Write `docs/sessions/W3-A.md` from plan.md 3.2 (registrations and env changes for D under "Notes for D and Z"). Commit and push.
3. End with your status and: "When W3-A, B and C all report complete, start W3-D from `docs/prompts/W3-D.md`."
