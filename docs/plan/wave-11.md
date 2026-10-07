# Wave 11: Admin API, watcher II, verify and social UI

**Goal.** Admins can run the game through the API. The watcher covers Free rounds, pages guardians, and is backed by a dead-man's switch. Players can browse rounds, verify their own entry in the browser, see profiles and boards, and share.

**Base.** Tag `wave-10`. **Hold point:** OA-D3 before W11-C. **Migrations reserved:** W11-A `0024`, W11-B `watcher/0002`, W11-D `0025`.

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
- **Owns.** `apps/api/src/admin/**`, `apps/api/src/routes/admin.ts`, `apps/api/src/flags/**`, migration `0024`, `apps/api/test/admin/**`, `apps/api/seed/house-questions.json`.
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
- Confirm OA-D5 is frozen before W12-C.
- Migrations for wave 12: W12-D `0026`.
