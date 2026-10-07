# Wave 3: Core services

**Goal.** Sign-in and sessions work. The RoundDO accepts sealed Free entries and returns signed receipts. The core round flow is designed. A local stack (drand, anvil, contracts, `wrangler dev`) runs a real Free entry end to end.

**Base.** Tag `wave-2`. **Hold points:** OA-01 (OrbStack working) before W3-D. OA-02 before W3-C.

**Migrations reserved:** W3-A `0002_auth.sql`, W3-B `0003_round_do.sql`, W3-D `0004_*` (use only if needed).

## Pinned interfaces

- Everything in wave 2's P2.4 (`packages/shared/src/**`, `apps/api/src/do/types.ts`, `apps/api/src/lib/**`, `apps/api/src/points/**`). Changing a pinned interface is a D/Z decision; parallel sessions note the need in their handoff.
- **Session middleware contract:** W3-A's middleware sets `c.set('user', { id, status, role, personId, kycStatus })` and `c.set('session', { idHash, kind: 'cookie' | 'bearer' })`. W3-B's routes use `requireUser` from `src/lib/auth-context.ts` and inject the user in tests with `test/helpers`.
- **Receipt signer key:** `RECEIPT_SIGNER_KEY` (Workers secret, hex). In tests and local runs it's generated and written to `.dev.vars`.

## W3-A: API auth and sessions

- **Role / size:** build, M.
- **Objective.** Implement the auth endpoints, sessions (cookie and Bearer), AuthDO, RateLimitDO, `GET /me` (profile, balances, limits, flags; Stakes eligibility returns `ineligible: not_verified` until W5-B), `PATCH /me` (handle, display name), `POST /me/tos`, `POST /auth/logout`, signup grant through `src/points/`, and Turnstile on signup.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W2-Z.md`. This section. Spec: "API" (rows `/auth/*`, `/me`, `/me/tos`, plus "Rate limits"), "Identity and personhood" (only "Identities"), "Data model" (rows `users`, `identities`, `sessions`, `point_balances`, `points_ledger`; the SIWE nonce paragraph), "Anti-abuse" (Turnstile bullet), "Modes: Free and Stakes" (Starting balance row).
- **Owns.** `apps/api/src/routes/{auth,me}.ts`, `apps/api/src/auth/**`, `apps/api/src/do/{auth-do,rate-limit-do}.ts`, `apps/api/migrations/0002_auth.sql`, `apps/api/test/auth/**`, `apps/api/test/me/**`, `e2e/mocks/farcaster/**`.
- **Deliverables.** SIWE (viem `verifySiweMessage`, EIP-1271 for smart wallets via an RPC binding mockable in tests). Farcaster Quick Auth verification (JWT against Farcaster's JWKS; a local mock JWKS in `e2e/mocks/farcaster`). Email codes: 8 digits, hashed in KV with a 5-minute TTL, 5 attempts per code, about 10 codes per hour per address, the email send behind an `EmailSender` interface. Sessions store hashed IDs. Bearer tokens for the mini app. Per-user and per-IP buckets. `security_notice` is enqueued (notify queue message only; W9-A sends it).
- **Required tests.** ID-4 (brute force, replay, Bearer flow); SIWE replay and wrong domain/chain; account creation only via Farcaster or SIWE (email cannot create); rate limits; NFR-8 part (IPs not persisted beyond the window; assert no IP column writes).
- **Acceptance checks.** `pnpm check` green; all routes validate with the P2.4 schemas.
- **Risks.** EIP-1271/6492 signatures from undeployed Coinbase Smart Wallets (handle ERC-6492).

## W3-B: RoundDO Free entries

- **Role / size:** build, M.
- **Objective.** Implement RoundDO's Free path: init from the locked config, the commit protocol (validation, dedupe, `seq` reservation, atomic points batch, leaf, EIP-712 receipt), counters, the alarm chain (open, `closing_soon`/`streak_at_risk` hooks that just enqueue, close, beacon-time settle enqueue, rule-8 alarm), close (drain in-flight, reconcile leaves against D1, build the commitment root with `freeCommitmentTree`), and `POST /rounds/:id/entries`. Also the daily grant on first entry.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W2-Z.md`. This section. Spec: "Real-time and the reveal" (only "RoundDO responsibilities"), "Sealed picks (timelock encryption)" (only "Free mode specifics", "Invalid entries", "Canonical ciphertext header"), "Data model" (rows `entries`, `round_modes`, `limits`; "Atomic points movements"), "Modes: Free and Stakes" (table), "Compliance and responsible play" (only "Responsible play").
- **Owns.** `apps/api/src/do/round-do.ts`, `apps/api/src/rounds/**`, `apps/api/src/crypto/receipt.ts`, `apps/api/src/routes/entries.ts`, `apps/api/migrations/0003_round_do.sql`, `apps/api/test/round-do/**`.
- **Must not touch.** WebSocket handling (W7-A owns `src/ws/**`; leave a `broadcast()` no-op hook), Stakes ingest beyond the RPC stub.
- **Required tests.** DO-1..4 and DO-5 (alarm chain half). A close-boundary race test with concurrent entries at `closesAt` (DO-3). Receipt verification against the root and the signer address. Insufficient balance leaves no entry, ledger row or `seq` gap. Room membership check against `room_members`.
- **Acceptance checks.** Every acknowledged entry is in the root. The non-canonical header and out-of-range stake are rejected at submit.
- **Risks.** D1 batch atomicity inside a DO; `seq` gaps on failure (reserve-then-release, or allocate after commit; document the choice and prove no gaps in receipts).

## W3-C (design): core round flow

- **Role / size:** design, M.
- **Objective.** Design every screen and state of the core round flow in Paper, at mobile, tablet and desktop: onboarding (three cards), sign-in (Farcaster, wallet, email; inside the mini app and in the browser), Today (Free and Stakes; signed out and signed in; Stakes hidden if ineligible; non-default config warning; DST notice), the sealing and submitting state, Sealed (pick known, pick lost from local storage), Unsealing countdown, Counting the flock, Reveal (win, loss, refund, Stakes provisional "Final at", mode toggle), "The next question is already live", Stakes entry (verify with Coinbase, pending transaction, error, mismatch-refusal), Claims (list, Claim all, empty, pending), and the global states (loading, error, offline, empty "The sheep are deliberating", blocked region, self-excluded).
- **Read first.** `plan.md` §5.4. `docs/design/README.md`, `docs/design/screens.md`. `Design_Language.md`. Spec: "Client app", "Real-time and the reveal" (only "Reveal choreography"), "Modes: Free and Stakes", "Identity and personhood" (only the first paragraph and "Personhood (verified Coinbase sign-in)" Flow bullet), "Compliance and responsible play". Schemas: `packages/shared/src/api/{rounds,entries,claims,me}.ts`, `packages/shared/src/ws.ts`.
- **First step.** Confirm the Paper MCP tools; if they're missing, stop as `blocked`.
- **Owns.** Paper page `Core flow`; `docs/design/screens.md` (core section); `docs/design/exports/core/**`.
- **Definition of done.** Every state listed has an artboard named per P2.3 at all three breakpoints (desktop may reuse the tablet layout centered, but it still needs an artboard), with an exported PNG and an inventory row. Motion notes for the reveal are on the artboards.
- **Open questions.** Where the 30-day Stakes net result sits on Today. Where the responsible-gambling link sits in Stakes onboarding. Record the choices.

## W3-D: Local stack + first Free entry end to end

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C. Build the local stack: a local drand network in Docker using the `bls-unchained-g1-rfc9380` scheme, anvil (`--fork-url` optional), the CREATE2 deploy, `.dev.vars` generation (fresh test keys), D1 migrations, and `wrangler dev`. Then prove a real Free entry end to end against it.
- **Read first.** `plan.md` §2, §4.3, §4.4. Handoffs W3-A, B, C. `contracts/README.md`, `packages/tlock/README.md`. Spec: "Testing and acceptance criteria" (only the "End to end (Playwright)" bullet's first paragraph).
- **Owns.** `e2e/stack/**` (`docker-compose.yml`, drand node configs, DKG bootstrap script, `up.mjs`, `down.mjs`, `env.mjs`), `e2e/package.json`, `e2e/tests/stack-smoke.test.ts`, registry files.
- **Deliverables.** `pnpm stack:up` / `pnpm stack:down` (idempotent, ~1 minute) and `pnpm stack:status`. Stack facts written to `e2e/stack/.state.json` (gitignored): drand chain info, contract addresses, keys' public addresses, API URL.
  - The smoke test signs in with SIWE (a test wallet), creates and locks a round directly through a test-only admin seam (env-guarded, local only), encrypts with `@flocked/tlock` to the local chain, submits, and verifies the receipt against `receiptSigner()` read from the local `FlockedAnchor`.
  - It then advances the clock to close, waits for the local beacon, and decrypts with `decryptWithSignature`.
- **Required tests.** `pnpm check`; `pnpm stack:up && node e2e/tests/stack-smoke.test.ts` (Vitest in Node) green. Add a CI job that runs the stack on Ubuntu (Docker available) for `w*-integration` and `main`.
- **Risks.** Running a local drand network with the unchained G1 scheme. If drand's Docker image can't do it, fall back to building the drand binary in the image. Record the approach in `e2e/stack/README.md`. Time travel: drand runs on real time, so keep the local period short (3 s), use a `beaconDelay` of 60 s and short test rounds rather than warping drand.
- **Emits.** W3-Z prompt.

## W3-Z checklist

- ID-4, DO-1..4 and DO-5 (alarms) proven; stack smoke green in CI.
- Ask the owner to review core flow in Paper (OA-D2 needed before W9).
- Migrations reserved for wave 4: W4-A `0005`, W4-B `0006`, W4-D `0007`.
- Confirm the audit-prep slot (W4-C) with the owner and that an auditor is booked (OA-20).
