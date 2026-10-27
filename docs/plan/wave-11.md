# Wave 11: Admin API, watcher II, verify and social UI

**Goal.** Admins can run the game through the API. The watcher covers Free rounds, pages guardians, and is backed by a dead-man's switch. Players can browse rounds, verify their own entry in the browser, see profiles and boards, and share.

**Base.** Tag `wave-10`. **Hold points:** OA-D5 (Admin) before W11-A (moved up from W12 by W7-Z, Oct 12); OA-D3 before W11-C. **Migrations reserved:** W11-A `0025`, W11-B `watcher/0002`, W11-D `0026` (shifted by W7-Z, Oct 12: W7-F1 took `0020`).

## W11-A: Admin API

- **Role / size:** build, M.
- **Objective.** Build `/admin/*` (role = admin, and Cloudflare Access JWT verification when configured):
  - schedule calendar reads; assign a question to a day; edit round config until lock;
  - question queue with moderation JSON; approve, reject with reason, edit wording (`question_edited`), add house questions;
  - live round health (status per mode, counters, DO health, indexer lag, anchor status, safe-head lag, settlement progress);
  - interventions: void before close (two-phase via the W4-D path), retry settlement, pause (operator/pauser key);
  - challenge-window list with watcher verdicts (from the watcher's public verdict endpoint);
  - users: search, suspend/unsuspend, identities, merges, entries, ledger, role (`POST /admin/users/:id/role`), manual points adjustment with a required reason;
  - flags and config (flags, geo allow/deny, fee defaults, notification copy overrides);
  - every action writes `audit_log`.

  Also draft ≥ 30 house-question candidates in a seed file for the owner to approve (OA-24).
- **Read first.** `plan.md` §2, §4. `docs/sessions/W10-Z.md`. Spec: "Admin console", "Question pipeline" (steps 4–5, "House questions"), "Modes: Free and Stakes" (flags paragraph).
- **Owns.** `apps/api/src/admin/**`, `apps/api/src/routes/admin.ts`, `apps/api/src/flags/**`, migration `0025`, `apps/api/test/admin/**`, `apps/api/seed/house-questions.json`.
- **Required tests.** Authz (non-admin and missing Access JWT rejected). No void after close via any admin path. Audit rows for every action. A flag change affects only rounds locked after it, except the Stakes kill switch (immediate).

## W11-B: Watcher II (Free, paging, dead-man)

- **Role / size:** build, M.
- **Objective.** Watcher Free checks: lock leaf vs published config, commitment, and manifest anchor; Free settlement and refund by recompute; rule-8 refund matches only if the watcher's own drand monitoring saw the beacon missing at +24 h. Receipt-signer history. Paging integration (a generic webhook, configured per env), heartbeats to the dead-man's switch (an external URL; OA-19), and the missing-verdict dead-man logic. Deploy config for a separate account (`apps/watcher/wrangler.jsonc` envs).
- **Read first.** `plan.md` §2, §4. `docs/sessions/W10-Z.md`. `apps/watcher/README.md`. Spec: "Smart contract" (only "Challenge window, watcher and guardian").
- **Owns.** `apps/watcher/**`.
- **Required tests.** PIPE-5 (Free and dead-man). AC-6 (receipts verify against the anchored commitment via watcher recompute). ALERT-7 (missing verdict).

## W11-C: Web round, archive, verify, profiles, boards

- **Role / size:** build (UI), M.
- **Objective.** Round detail `/r/:id` (both modes' splits, winners count, Farcaster cast link, verify link, generic card). Archive. The Verify page: manifest, chunk hashes, roots, drand round and signature, tx links, and "Verify my entry" via `@flocked/verify/browser` (decrypt own entry, check receipt and anchored root or `Entered` event, chunk and totals). Profile `/u/:handle`. Leaderboards (tabs, mode filter).
- **Read first.** `plan.md` §2. `docs/sessions/W10-Z.md`. `docs/design/screens.md` (social: round, archive, verify, profile, boards rows), the exports, those Paper artboards. Spec: "Client app" (those rows), "Profiles, leaderboards and rooms" (only "Profiles", "Leaderboards").
- **Owns.** `apps/web/src/features/{round,archive,verify,profile,boards}/**`, `e2e/ui/{round,archive,verify-page,profile,boards}.spec.ts`.
- **Required tests.** AC-3 (browser verify of own entry, Free and Stakes). Screenshots. axe.

## W11-D: Share sheet, mini app, push + e2e

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C. Build the share sheet in Reveal and Round (cast composer in the mini app, Web Share API, copy link, download image), pre-filled text per result, the teaser share after sealing, the "Remind me" web-push subscribe from Sealed, the mini app manifest (`/.well-known/farcaster.json`) and embed meta, and the service worker for push. e2e: a share card exists and the share URL's OG and Farcaster embed tags are correct (E2E-3, AC-7 unfurl part).
- **Read first.** `plan.md` §2, §3.4. Handoffs W11-A, B, C. `docs/design/screens.md` (share sheet rows). Spec: "Share cards and distribution" (only "Share surfaces").
- **Owns.** Registry files; `apps/web/src/features/share/**`; `apps/web/public/**` (manifest, service worker); `e2e/ui/share.spec.ts`.
- **Required tests.** E2E-3, AC-7.
- **Emits.** W11-Z prompt.

## W11-Z checklist

- AC-3, AC-6, AC-7, E2E-3, PIPE-5 (all) proven.
- Ask the owner to approve house questions (OA-24) and start OA-04 to OA-19 if not yet underway; staging needs them by wave 14.
- Migrations for wave 12: W12-D `0028` (W10-F1 may take `0027`).

## Carry-over from W4-Z (Oct 11, 2026)

- **W11-A** (the spec decisions said "W12", but the admin API is W11-A's; W12-C draws the UI):
  - the admin void calls `requestRoundVoid` (`apps/api/src/lifecycle/void.ts`) and writes an `audit_log` row. The void's state lives in the RoundDO;
  - a guardian-only release of a settlement hold sets `settlement_holds.released_at` / `released_by` and writes `audit_log`;
  - a non-default close publishes `nonDefaultAuditId` in the locked config. Add it to `LockedConfigSchema` (`packages/shared/src/config.ts`) and have `apps/api/src/scheduler/lock.ts` carry it. Today the scheduler only creates default closes.

## Carry-over from W5-Z (Oct 12, 2026)

- **W11-A:** edits to the `config` table (`geo.stakes.allow`, `geo.stakes.age21`, `mode.stakes.enabled`) write an `audit_log` row. The guardian's hold release covers `void_rate` holds (either mode, `tx_hash` NULL) as well as `foreign_entry`.

## Carry-over from W6-Z (Oct 12, 2026)

- **W11-A:** releasing a settlement hold, including `refund_vetoed`, which the coordinator opens after a guardian veto of a refund proposal; only the guardian releases a hold (Decision log, Oct 11) (owner decision, Oct 12; W6-F1 O1), with an `audit_log` row. The alert for that veto is `ALERT_DO_ERROR` step `refund_proposal_vetoed`.

## Carry-over from W7-Z (Oct 12, 2026)

- **All:** migrations shift by one, because W7-F1 took `0020`: W11-A `0025`, W11-D `0026`. OA-D5 (Admin) must be frozen before W11 starts (moved up from W12, Oct 12): W11-A builds the admin API from it.
- **W11-A** (it may edit the Free entry and `/prepare` eligibility checks for E2 and E5):
  - pause (decision E2) blocks new Stakes entries only (the escrow's pause): `/stakes/prepare` refuses tickets while the escrow is paused;
  - config (decision E5): a new key `geo.deny` (country and region codes) blocks entries in both modes and wins over `geo.stakes.allow` (values from OA-21); `mode.free.enabled` becomes Free's kill switch (Free entries refuse when it's off);
  - admin search (decision E7): exact match on user ID, wallet address, email and Farcaster FID; a case-insensitive prefix match on handle;
  - the schema gaps W7-C found in `packages/shared/src/api/admin.ts` (holds, live round, reasons, schedule, queue, users, config, analytics): see `docs/sessions/W7-C.md` "Notes for D and Z" › "Schema gaps for W11-A";
  - hold release history (decision C2): a second `refund_vetoed` veto reopens the released row with a new `created_at`, so history is read from `audit_log` (there is no hold ID); `released_by` is the recording admin, and the guardian's reference goes in the audit row's data.
- **W11-D:**
  - bearer tokens on WebSockets for the mini app (W7-A open issue): browsers can't set `Authorization` on a WebSocket, so a mini-app viewer of a room round gets 401 at the upgrade. Issue a short-lived token from an authenticated HTTP call, passed as `Sec-WebSocket-Protocol` or a query parameter. W11-D may edit `src/ws/upgrade.ts`;
  - the Farcaster hub (`FARCASTER_HUB_URL`, decision F6) is decided with OA-11 by W11. Unset, no Farcaster-verified wallet is offered. Neynar's hub needs an API key (a secret); staging (W14) needs a hub.

## Carry-over from W8-Z (Oct 16, 2026)

- **W11-A** (it may edit `src/scheduler/lock.ts` for the creator check):
  - mount the `questions/admin.ts` actions on `routes/admin.ts`; `adminQuestionView` serves the list page (W8-A);
  - there is no unassign action: a scheduled question must have another assigned to its day before it can be rejected;
  - a no-round day can't be rescued after its lock time; adding house questions only fills later days;
  - creator at lock (owner decision, Oct 16): the lock reads the escrow's treasury and refuses a draft whose creator differs, admin drafts included;
  - how an admin resolves a room question sent to review: Approve and Assign refuse it today (409 `conflict`); one option is approving it onto the room's next round.
- **W11-C:** handles are lowercase (`HandleSchema`), so `/users/Woolly` is 400: lowercase a handle before linking to a profile.
- **W11-D:**
  - share links and `?ref=` (owner decision, Oct 16): the web client keeps `?ref=` and `/s/:shareId` for 7 days (the attribution window; the server can't check its age) and sends the ref at sign-in;
  - mini app sign-in e2e: it needs a host-frame harness (W8-C open issue), with OA-11.

## Carry-over from W9-Z (Oct 16, 2026)

- **W11-C:**
  - `npx @flocked/verify` (AC-3): the bin loads TypeScript through `tsx`, like every workspace package; publishing needs a build (bundle `src/cli.ts` as ESM with `@flocked/*` inlined). Owner: W11-C, or the release wave if W11-C doesn't publish;
  - the Verify page verifies one entry (`verifyEntry`), not the whole round: decryption is sequential (about 6 ms an entry, about 10 min for 100k);
  - long `getLogs` scans on Base: a provider with a tight range limit makes the `RoleRevoked` and `OutcomeProposed` scans slow (they halve down to 500 blocks).
- **W11-D:** the web service worker shows `{ title, body, url, tag }` and subscribes with `VAPID_PUBLIC_KEY` through `POST /push/subscribe` (open to suspended accounts, decision B7); the mini app manifest's `webhookUrl` is `${API_ORIGIN}/api/v1/farcaster/webhook`. Sealed's "Remind me" opens Settings until a client flow subscribes (owner, Oct 16).

## Carry-over from W10-Z (Oct 26, 2026)

- **All:**
  - read `docs/sessions/W10-Z.md` "Decisions" for the spec sections changed on Oct 26;
  - **W10-F1** (API) and then **W10-F1.2** (web), on the branch `w10-f1-review-fixes`, run alongside W11-A/B/C from the tag `wave-10`. Their files are listed in `wave-10.md` "W10-F1 and W10-F1.2"; don't edit them;
  - OA-D5 (Admin) is frozen as is and OA-D3 is confirmed unchanged (owner, Oct 26): no hold on W11-A or W11-C;
  - W10-F1 may take migration `0027`; W12-D moves to `0028`.
- **W11-A:**
  - the override list (spec, Sealed picks › Round config check): `configWire` (`apps/api/src/read/rounds.ts:227`) always publishes `overrides: []`, so every non-default Stakes value is a watcher mismatch that pages. Publish each non-default value with its audit-log ID from the admin config edits, in the locked config at lock (`scheduler/lock.ts`) and on `/rounds/:id` and `/rounds/today`. The web's "See the change log" disclosure (W10-C) lists exactly that list;
  - the challenge-window list reads the watcher's public `GET /verdicts/:subject/:id` as pinned (`packages/shared/src/watcher.ts`). If W11-B gives a re-proposal its own verdict (below), the change is additive; show what the verdict names;
  - `src/lifecycle/**`, `src/indexer/**`, `src/identity/merge.ts`, `src/personhood/{config,flow}.ts` and `src/read/{me,claims}.ts` are W10-F1's: call them, don't edit them.
- **W11-B** (W10-Z's review of `apps/watcher`; each fix with a test that fails without it):
  - **high:** a verdict is tied to a proposal only by `bundleHash` (`run.ts:311-318`), and `@flocked/verify` takes the escrow round from the backend's manifest (`packages/verify/src/verify.ts:252`). An operator can publish a manifest for round Y that names a sham escrow round X it created with no entries, propose an honest too-few refund on X and an arbitrary `payoutRoot` on Y with the same `bundleHash`: Y gets `match` and nobody is paged. Compare Y's own `OutcomeProposed` (status, n0, n1, nVoid, `payoutRoot`, which `chain.proposed` already returns) with the recompute, and require the manifest's chain round to equal the snapshot's `chainRoundId`;
  - **re-proposals:** proposals are keyed `(round_id, bundle_hash)` (`migrations/0001_watcher.sql:38`) and a known hash is skipped (`run.ts:263-265`). The coordinator's re-proposal after a refund veto repeats the bundle, so it is never recorded or checked, and a different re-proposal never gets a verdict (`stakes_proposal` is write-once per round), only the missing-verdict page. Key proposals by transaction (`watcher/0002`) and give each proposal its own verdict (additive; W11-D copies `verdict.ts` into `packages/shared` again);
  - the house-question rule (the creator is the treasury) never reads `snapshot.isHouse` (`rules.ts:116-160`); the test "house question whose creator is not the treasury" passes only because `payoutAddress` is null;
  - a `RoundRefunded` reason 1 can come from a finalized refund *proposal* (VOID entries leave too few valid ones; `StakesMath.sol:48`), which `run.ts:380-392` publishes as a write-once `stakes_refund` mismatch and pages; `refund.test.ts:85` asserts the bug. Skip reason 1 when an `OutcomeProposed` exists (W9-F1's R2 tells the two apart the same way);
  - pages go out last in the tick (`run.ts:492-493`), and `putSnapshot` / `trackedRounds` sit outside any try: a tick that hits the CPU limit or throws early delivers no page at all. Page and flush first;
  - lows: an `unable` published at a proposal's +30 min deadline ends checking although the guardian has about an hour left; `page.ts:89-104` has no attempt cap or backoff and twenty always-rejected pages block newer ones; chain reads use `latest` with no confirmation depth while verdicts are write-once; the spec's "alerts on any veto that doesn't match a mismatch it reported" is not built (`ProposalVetoed` is never read);
  - the snapshot point is open, not lock (spec, Oct 26); Stakes room rounds are out of scope; the watcher's `COUNTRY_ALLOW` and the fail-closed `unable` are as built (spec, Smart contract › Challenge window);
  - Free watching on `watcher/0002`, paging (OA-18), the dead-man's switch (OA-19), and the recompute's CPU limit: `@flocked/verify` decrypts in one invocation (~6 ms an entry), so split it (a Durable Object or a queue) or verify a sample plus the roots before rounds get large;
  - the bundle is 2,277 KiB (424 KiB gzip): the second account needs Workers Paid (OA-04, OA-05).
- **W11-C:**
  - `/r/:id` and `/r/:id/verify` are still `Placeholder`s in `routes.tsx` (W11-D registers the pages);
  - the Verify page opens a Stakes entry through its `Entered` event; W10-C stores the plaintext under `flocked.pick.<userId>.<roundId>.stakes`, and since W10-D.2 a Stakes plaintext names the onchain round ID, not the ULID (`crypto/entry.ts` `sealPick(…, mode)`). `apps/web/src/crypto/**` is yours to read, not W10-F1.2's to edit.
- **W11-D:**
  - merge `w10-f1-review-fixes` as a fourth branch once W10-F1 and W10-F1.2 are both `complete`, and re-run a sample of their mutations on the merged tree;
  - the unfurl half of AC-7 (`e2e/ui/share.spec.ts`), `share_conversion` (the client sends the share ID back on the account's first entry), and fixtures for the 44 card exports `test/cards/fixtures/build.mjs` doesn't cover yet (`FIXTURES` and the `CASES` tables in `layout.test.ts` and `pixel.test.ts` extend to them);
  - the share sheet's Stakes card: a Stakes teaser exists from W10-F1 (an indexed `Entered`); share pages are daily-only (spec, Oct 26);
  - the mini app's external-browser verification has no automated test (W10-C): add one with the host-frame harness, or record why not;
  - the Coinbase Wallet SDK posts telemetry to `cca-lite.coinbase.com` from every page (W10-D.2; `preparePage` blocks it in tests): turn it off in the wagmi connector, or record it for the privacy notice (OA-21);
  - E2E's `api` job lists its spec files by hand (`e2e.yml`, plan.md 4.3): add any new `e2e/tests/*.spec.ts` to `core` or `warp`, and add a check (for example in `e2e/ui/phases.test.ts`'s neighbour) that every API spec is in exactly one group. `ui` runs every `e2e/ui` file in two steps (`--project=ui`, then `--project=ui-warp --no-deps`);
  - CI time on the W10-Z head: `ui` about 22 min, `api` core 18 and warp 15. Split `ui` like `api` if it passes about 35 min.
