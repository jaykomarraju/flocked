# Wave 7: Real time and identity

**Goal.** Live WebSocket updates and the reveal broadcast at scale. Full identity management (linking, merges, deletion, limits and exclusion). The admin console is designed. A Playwright harness runs complete Free and Stakes lifecycles against the local stack at the API level.

**Base.** Tag `wave-6`. **Migrations reserved:** W7-A `0014`, W7-B `0015`, W6-F1 `0016` (reassigned from W7-D by W6-Z, Oct 12: the `refund_vetoed` hold needs a `settlement_holds` rebuild). W7-D has no number of its own: a schema change it needs goes into `0016` before the merge to `main` (it is applied nowhere yet), with a note in its handoff.

## Pinned interfaces

- **WS:** messages per `packages/shared/src/ws.ts`. `GET /rounds/:id/ws` routes to a `RoundViewerDO` shard chosen by hash(connection id) mod N (N = 16 default, from config). RoundDO's existing `broadcast()` hook now calls `RoundViewerDO.broadcast` on every shard.
- **Identity:** W7-B implements `POST /me/identities/link`, `POST /me/merges/:id/confirm`, `DELETE /me/identities/:id`, `POST /me/email`, `POST /me/email/verify`, `DELETE /me`, `PUT /me/limits`, `POST /me/limits/exclusion-lift`, and `GET /me/referrals` (a stub returning an empty list until W8-B). Route module files: `identity.ts`, `limits.ts`.
- **e2e harness:** `e2e/` gets Playwright with two projects, `api` (this wave) and `ui` (W8-C on). Shared fixtures go in `e2e/fixtures/` (`stack`, `wallet`, `user`, `clock`).

## W7-A: WebSocket hub + viewer shards

- **Role / size:** build, M.
- **Objective.** Build WebSocket hibernation in RoundViewerDO shards, which subscribe to the primary RoundDO. The `state` snapshot on connect and reconnect; `counts` coalesced to at most 1 per second; `closed`, `revealing`, `revealed` (Stakes carries `claimsOpenAt` once the proposal is confirmed) and `refunded` (provisional flag for Stakes refund proposals). Room rounds are members only (an auth check at upgrade).
- **Read first.** `plan.md` §2, §4. `docs/sessions/W6-Z.md`. This section. Spec: "Real-time and the reveal", "Non-functional requirements" (only "Scaling notes", WebSocket bullet).
- **Owns.** `apps/api/src/ws/**`, `apps/api/src/do/round-viewer-do.ts`, the `broadcast()` seam in `apps/api/src/rounds/hooks.ts` (the RoundDO calls it; W6-Z corrected the path, Oct 12) and, in `round-do.ts`, only the messages it hands to it (note them in the handoff), migration `0014` if needed, `apps/api/test/ws/**`.
- **Required tests.** DO-5 (reconnect snapshot). PIPE-1 (WS half: no option data before `revealed`). Coalescing. Shard fan-out with 16 shards and many sockets in the Workers runtime.

## W7-B: Identities, merges, deletion, limits

- **Role / size:** build, M.
- **Objective.** Implement the identity rules:
  - linking with proof (SIWE, Farcaster, email code, Coinbase via W5-B's flow), with auto-offered Farcaster-verified wallets;
  - unlink limits (last sign-in identity, bound coinbase, wallet with non-final Stakes entries or unclaimed payouts);
  - pending merges (never inside an OAuth callback) and confirmation by signing in to the other account, with every refusal rule and the kept-account transfer rules (person ID, lower cap and pending increase, identities, per-scope balances via paired `merge` ledger rows, room memberships and ownership), plus the 30-day limit;
  - account deletion (anonymize, tombstone with cap state, merged accounts, expire merges, enqueue card re-render, refuse during exclusion or suspension or non-final rounds);
  - limits: cap decrease immediate, increase after 24 h;
  - self-exclusion: timed terms, permanent, no shortening, lift after 6 months with 7-day cooling-off;
  - `security_notice` enqueues;
  - `audit_log` rows.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W6-Z.md`. This section. Spec: "Identity and personhood" (only "Identities", "Merging accounts"), "Compliance and responsible play" (only "Responsible play"), "Data model" (rows `identities`, `merges`, `limits`, `users`).
- **Owns.** `apps/api/src/identity/**`, `apps/api/src/limits/**`, `apps/api/src/routes/limits.ts` and the identity and merge endpoints' handlers in `apps/api/src/routes/me.ts` (they are `me`-module rows in `ENDPOINTS`; replace their stubs and delegate to `src/identity/**`, W2-Z), migration `0015`, `apps/api/test/{identity,limits}/**`.
- **Required tests.** ID-1 (all). E2E-9 (API-level unit/integration with the test clock). Deletion anonymizes and keeps ledger rows. A merge moves balances atomically with paired ledger rows.

## W7-C (design): admin console

- **Role / size:** design, M (S if the component set covers most of it).
- **Objective.** Design the admin console at desktop and tablet: the schedule calendar with config editing until lock; the question queue with moderation JSON, predicted split warning, approve, reject with reason, edit wording and add house question; the live round (status per mode, counters, DO health, indexer lag, anchor status, safe-head lag, settlement progress); interventions (void before close with two-phase confirmation, retry settlement, pause) with confirmations; the challenge window list with watcher verdicts; users (search, suspend, identities, merges, entries, ledger, role, manual adjustment with reason); flags and config (flags, geo lists, fee defaults, notification copy); and the analytics dashboard tab.
- **Read first.** `plan.md` §5.4. `docs/design/README.md`, `docs/design/screens.md`. `Design_Language.md`. Spec: "Admin console", "Analytics" (only "Dashboard metrics"). Schemas: `packages/shared/src/api/admin.ts`.
- **First step.** Confirm the Paper MCP tools; if missing, stop as `blocked`.
- **Owns.** Paper page `Admin`; `docs/design/screens.md` (admin section); `docs/design/exports/admin/**`.

## W7-D: e2e harness + backend lifecycle e2e

- **Role / size:** integrate, M.
- **Objective.** Merge A, B, C and W6-F1 (the wave-6 review fixes, `wave-6.md` "W6-F1"; owner decision, Oct 12, 2026). Build the Playwright harness (`pnpm e2e`) over the local stack, with fixtures for users, wallets (anvil accounts and a Coinbase Smart Wallet stand-in where needed), the Coinbase mock, the test clock, and anvil time warp. Write API-level lifecycle e2e:
  - full Free and Stakes daily-shaped rounds with no manual step (AC-1 local);
  - Stakes claims after the challenge window (E2E-4 API);
  - the veto of a refund proposal followed by a settlement (E2E-6);
  - two identical Stakes ciphertexts both count (E2E-10);
  - the drand-outage rule-8 refund with the simulated clock (E2E-14);
  - the refund timeout when the operator never proposes (AC-5 part, `stakes-timeout.spec.ts`).
- **Read first.** `plan.md` §2, §3.4, §4.3. Handoffs W7-A, B, C and W6-F1. `e2e/stack/README.md`. Spec: "Testing and acceptance criteria" (only the "End to end (Playwright)" bullets).
- **Owns.** Registry files; `e2e/**` (except `e2e/mocks/*` content owned earlier, which D may extend); `.github/workflows/e2e.yml`.
- **Required tests.** `pnpm e2e` green locally and in CI. E2E-1 (API), E2E-2 (API), E2E-4 (API), E2E-6, E2E-10, E2E-14, AC-1 (local), AC-5 (timeout part).
- **Risks.** CI time. Keep rounds short with config, and run e2e only on integration branches and `main`.
- **Emits.** W7-Z prompt.

## W7-Z checklist

- DO-5, ID-1, PIPE-1 (WS), E2E-1/2/4 (API), E2E-6, E2E-10, E2E-14, AC-1 (local) proven.
- W6-F1's items (R1–R13, O1–O5) each have a passing test, and W6-F1 is merged.
- Ask the owner to review Admin in Paper (OA-D5 before W12). Confirm OA-D1 is frozen before W8-C starts; if it isn't, W8-C waits and W8 runs with A, B and D only.
- Migrations for wave 8: W8-A `0017`, W8-B `0018`, W8-D `0019`.

## Carry-over from W2-Z (Oct 8, 2026)

- **W7-A:** the WS `refunded` message gains `provisional` and `finalAt` (Decision log, Oct 8; `packages/shared/src/ws.ts`).
- **W7-B:** see the ownership change above (identity handlers in `routes/me.ts`).

## Carry-over from W3-Z (Oct 9, 2026)

- **W7-B** (W3-A review and owner decisions, Oct 9):
  - **Reserved handles:** a case-insensitive blocklist in `packages/shared`, enforced by `PATCH /me`.
  - **Email enumeration (owner chose W7-B):** `/auth/email/verify` reveals whether an address has an account ("Wrong code; 4 attempts left" vs "No valid code"). For unlinked addresses, issue a code with a no-op sender inside the same background task, and give unknown and used codes the same message. Add a test.
  - **Write email codes through `AuthDO`, not KV.** KV's edge cache can be about 60 s stale, so a resent code can fail and the old one lives on.
  - **AuthDO KV calls:** wrap them and return `unavailable`; a throw inside `blockConcurrencyWhile` resets the object.
  - **Migration test:** a test that `users` after `0002` equals `0001` except the nullable handle: CHECKs, defaults, types, and existing rows surviving.
  - **Unverified identity rows** (wallet, Farcaster) must not block sign-in (`accounts.ts` `findAccount`).
  - **Suspended accounts** sign in read-only. Every write route refuses `account_suspended` (spec, Oct 9). Check the routes that exist by then.
- **W7-D:**
  - reuse `e2e/stack/env.mjs` and the seam;
  - add a local Turnstile siteverify mock (the stack smoke calls `challenges.cloudflare.com` today);
  - make the seam's 404 body match the app's ("Not found", `apps/api/src/lib/errors.ts`).

## Carry-over from W5-Z (Oct 12, 2026)

- **W7-B:**
  - write `person_tombstones` at account deletion (migration 0009; `apps/api/src/personhood/verify.ts` applies and deletes them on verification);
  - merge confirmation for pending merges that the personhood callback creates (7-day TTL);
  - refuse to unlink the coinbase identity;
  - `apps/api/src/auth/profile.ts` `stakesReasons` is computed and then overridden by `meView` (`routes/me.ts`). Delete it, or make `buildMe` take the eligibility.
- **W7-C:** before the admin pages, these Paper fixes (owner decisions, Oct 12), re-exporting what they touch:
  - remove the "Questions" header link from the Core flow tablet and desktop headers (74 artboards) and from the navigation sheet (Client app "Navigation": no header links);
  - draw `security_notice` as a locked, always-on row in Settings › notifications (spec "Notifications": always on);
  - the Streaks board ranks the best stray streak (all time), with the current streak as the caption; the accent pill marks the board's top live streak only;
  - the five kit fixes on Components and in `docs/design/README.md`: secondary pills keep the surface fill, and the places that assume "transparent" are corrected; captions follow the type table (Inter 500, muted); the mode toggle's selected segment gets a check; the rank slot grows to 32px; optional sheets close with a "Not now" text button, and the 48px pill stays only where closing is the sheet's main action (claim all).
  The admin "flags and config" screen covers the `config` table's keys, including `geo.stakes.age21`.

## Carry-over from W6-Z (Oct 12, 2026)

- **All:** read `docs/sessions/W6-Z.md` for the spec sections changed on Oct 12. **W6-F1** (review fixes and five owner decisions) runs alongside W7-A/B/C from the tag `wave-6`; its files are listed in `wave-6.md` "W6-F1". Don't edit them.
- **W7-A:**
  - `/rounds/:id/ws` already sits behind `requireRoundAccess` (`routes/rounds.ts`); keep it, and send no per-option data before the mode's `revealed_at`;
  - the RoundDO's Stakes status stays `settle_proposed` after `RoundFinalized`, because no final ModeResult reaches it; D1 (`round_modes`) is the record. The `state` snapshot and the Stakes `revealed`/`refunded` messages must read D1 or give the RoundDO the final status;
  - non-cached `GET /rounds/:id` reads the RoundDO's live counts each time; the WebSocket should take most of that traffic.
- **W7-B:**
  - reuse `effectiveDailyCap` and `DEFAULT_DAILY_STAKE_CAP` (`src/stakes/cap.ts`) in the limits route;
  - `AcceptTosRequest.ageAttested` becomes `18 | 21`, the age the checkbox named (owner decision, Oct 12): `POST /me/tos` records it and refuses an attestation below the age required for the request (`personhood/age.ts`). Make `TosState.ageRequired` required and add it to `packages/shared/test/fixtures/api/me.json`;
  - the daily cap and the one-live-ticket rule are per account (W6-B review). A merge must keep both accounts' game-day stakes and live tickets counted for the kept account, and a person who deletes an account and verifies again the same game day must not start at zero (`person_tombstones` carries only the cap setting);
  - the merge notices in `packages/shared/src/copy/notifications.ts` ("Account merge pending", "Accounts merged") assume a merge completes by itself (W6-C open question (c), owner: check it). Report any copy change for W7-Z.
- **W7-C:** before the admin pages, on the frozen page `Cards and notifications` (owner decision, Oct 12): swap the URL "flocked.app" for **flocked.xyz** on every card, share page and email, replace the "@jay" handle in the share previews (cloned from the reveal screen) with a sample handle, and re-export what changes. Update `docs/design/screens.md` to match.
- **W7-D:**
  - merge W6-F1 as a fourth branch (see the W7-D objective);
  - E2E-6 (a vetoed refund proposal followed by a settlement): after a refund veto the coordinator now waits on a settlement hold (W6-F1 O1), so the test releases it through the seam route W6-F1 adds;
  - anvil's clock trails wall time after `indexer-reorg` (`evm_revert`); `stakes-ticket` mines to `opensAt`. The harness's `clock` fixture should mine before any step that depends on chain time;
  - `wrangler dev` can drop a request under load: on `main` @ `3a2d76f` one of `free-settle`'s 50 entry POSTs answered workerd's non-JSON "Error: Network connection lost" (Stack run 38305750622, attempt 1; the re-run passed, as did the same tree on `w6-integration`). The harness's HTTP helper should report a non-JSON answer clearly and retry a request only where it is idempotent (an entry is: one per user and mode);
  - stack seams to reuse: `POST /__test/rounds/scheduled` (with `stakes` and `free`), `POST /__test/stakes/tickets`, the cron driver, `GET /__test/rounds/:id` (a `stakes` section), `GET /__test/bundles/:id/:mode/:file`; the real `/prepare` → signer → `enter` path runs on the stack (`e2e/tests/stakes-ticket.test.ts`). `stakes-settle` moves anvil's clock 2 h, so only `claims-wallet` runs after it (`e2e/vitest.config.ts`'s sequencer).
