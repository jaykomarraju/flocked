# Wave 7: Real time and identity

**Goal.** Live WebSocket updates and the reveal broadcast at scale. Full identity management (linking, merges, deletion, limits and exclusion). The admin console is designed. A Playwright harness runs complete Free and Stakes lifecycles against the local stack at the API level.

**Base.** Tag `wave-6`. **Migrations reserved:** W7-A `0014`, W7-B `0015`, W7-D `0016`.

## Pinned interfaces

- **WS:** messages per `packages/shared/src/ws.ts`. `GET /rounds/:id/ws` routes to a `RoundViewerDO` shard chosen by hash(connection id) mod N (N = 16 default, from config). RoundDO's existing `broadcast()` hook now calls `RoundViewerDO.broadcast` on every shard.
- **Identity:** W7-B implements `POST /me/identities/link`, `POST /me/merges/:id/confirm`, `DELETE /me/identities/:id`, `POST /me/email`, `POST /me/email/verify`, `DELETE /me`, `PUT /me/limits`, `POST /me/limits/exclusion-lift`, and `GET /me/referrals` (a stub returning an empty list until W8-B). Route module files: `identity.ts`, `limits.ts`.
- **e2e harness:** `e2e/` gets Playwright with two projects, `api` (this wave) and `ui` (W8-C on). Shared fixtures go in `e2e/fixtures/` (`stack`, `wallet`, `user`, `clock`).

## W7-A: WebSocket hub + viewer shards

- **Role / size:** build, M.
- **Objective.** Build WebSocket hibernation in RoundViewerDO shards, which subscribe to the primary RoundDO. The `state` snapshot on connect and reconnect; `counts` coalesced to at most 1 per second; `closed`, `revealing`, `revealed` (Stakes carries `claimsOpenAt` once the proposal is confirmed) and `refunded` (provisional flag for Stakes refund proposals). Room rounds are members only (an auth check at upgrade).
- **Read first.** `plan.md` §2, §4. `docs/sessions/W6-Z.md`. This section. Spec: "Real-time and the reveal", "Non-functional requirements" (only "Scaling notes", WebSocket bullet).
- **Owns.** `apps/api/src/ws/**`, `apps/api/src/do/round-viewer-do.ts`, the `broadcast()` body in `round-do.ts` (only that method; note it in the handoff), migration `0014` if needed, `apps/api/test/ws/**`.
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
- **Objective.** Merge A, B and C. Build the Playwright harness (`pnpm e2e`) over the local stack, with fixtures for users, wallets (anvil accounts and a Coinbase Smart Wallet stand-in where needed), the Coinbase mock, the test clock, and anvil time warp. Write API-level lifecycle e2e:
  - full Free and Stakes daily-shaped rounds with no manual step (AC-1 local);
  - Stakes claims after the challenge window (E2E-4 API);
  - the veto of a refund proposal followed by a settlement (E2E-6);
  - two identical Stakes ciphertexts both count (E2E-10);
  - the drand-outage rule-8 refund with the simulated clock (E2E-14);
  - the refund timeout when the operator never proposes (AC-5 part, `stakes-timeout.spec.ts`).
- **Read first.** `plan.md` §2, §3.4, §4.3. Handoffs W7-A, B, C. `e2e/stack/README.md`. Spec: "Testing and acceptance criteria" (only the "End to end (Playwright)" bullets).
- **Owns.** Registry files; `e2e/**` (except `e2e/mocks/*` content owned earlier, which D may extend); `.github/workflows/e2e.yml`.
- **Required tests.** `pnpm e2e` green locally and in CI. E2E-1 (API), E2E-2 (API), E2E-4 (API), E2E-6, E2E-10, E2E-14, AC-1 (local), AC-5 (timeout part).
- **Risks.** CI time. Keep rounds short with config, and run e2e only on integration branches and `main`.
- **Emits.** W7-Z prompt.

## W7-Z checklist

- DO-5, ID-1, PIPE-1 (WS), E2E-1/2/4 (API), E2E-6, E2E-10, E2E-14, AC-1 (local) proven.
- Ask the owner to review Admin in Paper (OA-D5 before W12). Confirm OA-D1 is frozen before W8-C starts; if it isn't, W8-C waits and W8 runs with A, B and D only.
- Migrations for wave 8: W8-A `0017`, W8-B `0018`, W8-D `0019`.

## Carry-over from W2-Z (Oct 8, 2026)

- **W7-A:** the WS `refunded` message gains `provisional` and `finalAt` (Decision log, Oct 8; `packages/shared/src/ws.ts`).
- **W7-B:** see the ownership change above (identity handlers in `routes/me.ts`).
