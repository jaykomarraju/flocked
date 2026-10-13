# Wave 8: Content, social and the web shell

**Goal.** The question pipeline (submit, moderation, vote, queue, creator credit), stats and boards, and rooms exist on the backend. The web app shell is built from the frozen foundations, with sign-in working in the browser and inside the mini app.

**Base.** Tag `wave-7`. **Hold point:** OA-D1 (foundations frozen) before W8-C. **Migrations reserved:** W8-A `0017`, W8-B `0018`, W8-D `0019`; W7-F1 `0020` (added by W7-Z, Oct 12: R18's `indexer_state` column).

## Pinned interfaces

- **Settlement hooks for stats and credit:** W8-A and W8-B each register a post-final hook through `apps/api/src/settlement/hooks.ts` (created by W8-B, which owns it this wave). The registry is `onModeFinal(handler)`, called by Free apply when the mode settles or refunds and by the Stakes indexer handler at `RoundFinalized`. W8-A adds its handler in its handoff for D to register (creator award / split quality).
- **Web app layout (W8-C):** `apps/web/src/routes.tsx` (registry, D-owned after this wave), `apps/web/src/ui/**` (components from Paper), `apps/web/src/theme/**` (imports `@flocked/shared/design-tokens.json`, no retyped values), `apps/web/src/api/client.ts` (typed client over `packages/shared/src/api`), `apps/web/src/auth/**`, and `packages/shared/src/mascot/**` (placeholder SVG React components, per Design_Language.md).
- **Screenshot tests:** `e2e/ui/*.spec.ts` compare against `docs/design/exports/<surface>/...png` with a pinned tolerance (`maxDiffPixelRatio` 0.01, fonts self-hosted, animations disabled). The helper is `e2e/fixtures/screenshot.ts` (W8-C).

## W8-A: Question pipeline

- **Role / size:** build, M.
- **Objective.**
  - `POST /questions` with format validation and synchronous moderation: Claude Sonnet 5.5 (`claude-sonnet-5-5`) through the Anthropic TS SDK, with a cached system prompt for the rubric, low effort, and structured outputs (`output_config.format`). Duplicate detection uses Workers AI embeddings and Vectorize (≥ 0.9 over 365 days). A refusal or failure routes the question to admin review. The full JSON goes in `moderation_json`.
  - Votes, with the score decayed at a 3-day half-life; `GET /questions?status=queued&sort=top` (top 50).
  - The 3/day limit, and the 5-rejections-in-7-days block.
  - Split quality, and the creator award / creator fee crediting hook.
  - `question_used` and `question_edited` enqueues.
  - Turnstile on submit.
  - Load the `claude-api` skill before writing the SDK call.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W7-Z.md`. This section. Spec: "Question pipeline", "Core game rules" (only "Question format"), "Anti-abuse" (spam bullet).
- **Owns.** `apps/api/src/questions/**`, `apps/api/src/moderation/**`, `apps/api/src/routes/questions.ts`, migration `0017`, `apps/api/test/questions/**`, `e2e/mocks/anthropic/**`.
- **Required tests.** Moderation decision table (mocked SDK, including refusal and error → admin review). Duplicate detection with a Vectorize mock. Decay scoring. The 7-day block (API part of E2E-13).

## W8-B: Stats, streaks, boards, referrals

- **Role / size:** build, M.
- **Objective.** Build `user_stats` updates on final daily-round outcomes only: Free at settlement, Stakes when final. Game-day streak rules (refunded and voided are neutral for stray streaks; refunded still counts as played). Leaderboards Strays, Streaks, Weekly (ISO week of the game day) and Creators, with tie-breaks and a mode filter, verified users only, excluding merged and deleted accounts. Public profiles `GET /users/:handle` (private Stakes net unless opted in). Referrals: `ref_code` attribution (7 days) and qualification by the first valid Free daily entry settling, 100 points each, 10 per referrer per week, the anti-farming account-age and linked-identity rule. `GET /me/referrals`.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W7-Z.md`. This section. Spec: "Profiles, leaderboards and rooms" (only "Profiles", "Game day and streaks", "Leaderboards"), "Share cards and distribution" (only "Referral"), "Anti-abuse" (points farming bullet).
- **Owns.** `apps/api/src/stats/**`, `apps/api/src/boards/**`, `apps/api/src/referrals/**`, `apps/api/src/settlement/hooks.ts`, `apps/api/src/routes/{boards,users}.ts`, migration `0018`, `apps/api/test/{stats,boards,referrals}/**`.
- **Required tests.** Streak rules across refunded and voided days and DST weeks. Tie-breaks. Verified-only boards. Referral cap and qualification.

## W8-C: Web shell + sign-in

- **Role / size:** build (UI), M.
- **Objective.** Build the Vite + React app: theme from tokens (light and dark, `prefers-color-scheme`), self-hosted Fredoka and Inter, the component library implemented to match the Paper Components page, mascot placeholders, layout and navigation, the onboarding modal, sign-in (SIWE through wagmi + Coinbase Smart Wallet, Farcaster in the mini app via `@farcaster/miniapp-sdk` Quick Auth → Bearer, email code), the session-aware API client, global loading, error, offline and empty states, and the Playwright UI project with the screenshot helper.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W7-Z.md`. This section. `docs/design/screens.md` (foundations, components, core: onboarding and sign-in rows only), the matching exports, and through the Paper MCP only those artboards. `Design_Language.md`. Spec: "Client app" (first paragraph and Onboarding row).
- **Owns.** `apps/web/**`, `packages/shared/src/mascot/**`, `e2e/ui/{shell,onboarding,sign-in}.spec.ts`, `e2e/fixtures/screenshot.ts`, `e2e/playwright.config.ts` (UI project only; coordinate in the handoff).
- **Required tests.** Component tests (Vitest + Testing Library). Screenshot comparisons for every component and onboarding/sign-in artboard. axe checks on each screen (no serious violations). Sign-in e2e against the local stack.
- **Risks.** Pixel drift from fonts; pin font files and disable animations in screenshots.

## W8-D: Rooms

- **Role / size:** integrate, M.
- **Objective.** Merge A, B, C and W7-F1 (the wave-7 review fixes, `wave-7.md` "W7-F1"; owner decision, Oct 12, 2026). Build rooms:
  - `POST /rooms`, `POST /rooms/join`, `GET /rooms/:id`, `POST /rooms/:id/questions` (moderated via W8-A);
  - room rounds created by the scheduler (mirror or custom), one RoundDO per room round;
  - room points (500 on join, +100 per room round under 1,000) via `src/points`;
  - qualification of ≥ 3 distinct qualifying entrants with accounts ≥ 24 h old at `closesAt`, recorded per entry in the members-only bundle;
  - the room leaderboard (room points, wins this week, streaks);
  - member picks after the reveal;
  - excluded from global stats and referrals;
  - the Stakes-rooms flag (off), with tickets restricted when it's on.
- **Read first.** `plan.md` §2, §3.4. Handoffs W8-A, B, C and W7-F1. Spec: "Profiles, leaderboards and rooms" (only "Rooms"), "API" (room rows).
- **Owns.** Registry files; `apps/api/src/rooms/**`; `apps/api/src/routes/rooms.ts`; migration `0019`; `apps/api/test/rooms/**`; `e2e/tests/rooms.spec.ts`.
- **Required tests.** Non-member entry and view rejected. Room minimum refund. Room rounds never touch global stats. A room round settles on the local stack.
- **Emits.** W8-Z prompt.

## W8-Z checklist

- Moderation and boards tests named; UI screenshot suite green in CI.
- W7-F1's items (R1–R18) each have a passing test, and W7-F1 is merged.
- Raise the OA-D3 review (Social, Settings) with the owner. Apply its Paper fixes and the W7-Z design items (the Streaks pill wraps the row's current streak, decision E3; the share sheets' viewer avatar "J" becomes "W", F5) through a design subagent, re-exporting what changes, before W11.
- OA-D2 is already frozen (Oct 12), so W9-C needs no check.
- Migrations for wave 9: W9-A `0021`, W9-B none, W9-D `0022`.

## Carry-over from W2-Z (Oct 8, 2026)

- **W8-B:** the CHECK `best_stray_streak >= stray_streak` means both columns change in one `UPDATE`.
- **W8-C:** navigation is five tabs: Today, Archive, Boards, Rooms, You; Submit, Queue, Claims and Settings under You on mobile and in the header's avatar menu on tablet and desktop, not as header links (Decision log, Oct 8 and Oct 9). W8-C also builds the placeholder mascot React components in `packages/shared/mascot` from the Paper `sheep/*` layers (Design_Language "Mascot").

## Carry-over from W3-Z (Oct 9, 2026)

- **W8-D:** room-round grants (owner decision, Oct 9): +100 room points per room round below a room balance of 1,000, ledger reason `room_grant`. A skip is final for that round and recorded in `daily_grant_skips`, keyed by the round. Reuse `src/rounds/grant.ts`.
- **W8-B:** the crowd-history hint (Client app, Today; Oct 9): the category's average winning-side share over its last 30 settled daily rounds, hidden below 5. Expose it on `GET /rounds/today`.

## Carry-over from W4-Z (Oct 11, 2026)

- **W8-B:** the referral bonus uses the daily grant's points-farming rule, as the spec revised it on Oct 11 ("Anti-abuse"). Reuse the eligibility check in `apps/api/src/rounds/grant.ts` (`recordPriorTransactions` first).
- **W8-D:** the scheduler refuses to lock a room round without a question (`apps/api/src/scheduler/lock.ts`). Room questions and room config are defined here.

## Carry-over from W5-Z (Oct 12, 2026)

- **W8-B:** the Streaks board ranks the best stray streak (all time), showing the current streak; ties go to the current streak, then rounds played (spec "Profiles, leaderboards and rooms", Oct 12).
- **W8-D:** room `qualifies` flags. The settlement counts every valid room entry today (`apps/api/src/settlement/reduce.ts`; `countQualifyingOnly` exists in `@flocked/settle`).
- **OA-09:** the Coinbase OAuth app must exist by now (redirect URI `${APP_ORIGIN}/api/v1/me/personhood/callback`, scopes `wallet:user:read` and `identity:user:address:read`).

## Carry-over from W7-Z (Oct 12, 2026)

- **All:** read `docs/sessions/W7-Z.md` for the spec sections changed on Oct 12. **W7-F1** (review fixes and three owner decisions) runs alongside W8-A/B/C from the tag `wave-7`; its files are listed in `wave-7.md` "W7-F1". Don't edit them, except where an item below says so.
- **W8-A:**
  - creator at lock (decision C5): whoever resolves the creator sets `creator` and `payoutAddress` together at lock, with the author-wallet checks (verified, linked, attestations). W8-A may edit `src/scheduler/lock.ts` for this and for E4's day with no round;
  - the pipeline rules (decision E4): Approve moves `submitted → queued`; Assign schedules; a rejection notifies the author with its reason (`question_rejected`: W8-A enqueues, W9-A writes the copy); the house backlog alerts when it drops below 14; if nothing can be locked (no scheduled question and an empty house backlog), that game day has no daily round and the admin is alerted;
  - a CHECK on `questions.category`, or a schema parse where it is read. D1 values are served unchecked: the seam's `'test'` category broke `GET /rounds/:id` for clients while the API answered 200 (W7-D open issue);
  - question and vote writes refuse suspended accounts with `account_suspended` (decision B7).
- **W8-B:**
  - a game day with no daily round (E4) is neutral for streaks;
  - boards, streaks and profiles exclude deleted and merged accounts (W7-B open issue);
  - `GET /me/referrals` replaces W7-B's stub in `routes/me.ts`. W7-F1 edits other handlers in that file, so touch only the referrals handler.
- **W8-C:**
  - the e2e harness (W7-Z review; W8-C owns the `ui` project, and may edit `e2e/playwright.config.ts`, `.github/workflows/e2e.yml` and `e2e/fixtures/{clock,http}.ts` for these):
    - the `ui` project gets `grepInvert: /@warp/` and a `ui-warp` phase, and every warp phase runs after every non-warp phase that shares the stack, or `pnpm e2e:ui` gets its own fresh stack (medium, latent);
    - Playwright's `globalTimeout` stays under the job's 45 minutes (`e2e.yml`), so the report is written;
    - drop the trailing `clock.release()` after warps, or floor the pin at wall time;
    - a GET retry opt-out (`idempotent: false`) for the Coinbase OAuth callback in `fixtures/http.ts`;
  - Paper (decisions E1, F5): the Foundations type-table row for captions (Inter 500, muted), and the nav-bar inactive label note renamed "nav label" (13/18 Inter 400 ink stays);
  - a `mono` font token (decision E8: ui-monospace, SFMono-Regular, Menlo, monospace) in `packages/shared/design-tokens.json`, and its schema if needed;
  - only if W8-C touches the WebSocket (otherwise W9-C does it): the first message is always `state`, possibly followed by catch-up events; send "ping" to keep a socket alive (answered "pong"); reconnect with jitter (W7-A).
- **W8-D:**
  - merge W7-F1 as a fourth branch (see the W8-D objective);
  - account deletion and rooms (decision B5): rooms the deleted user owns pass to the oldest remaining member (by join time), and a room with no other member closes. W8-D may edit `src/identity/delete.ts` for this after merging W7-F1;
  - room writes refuse suspended accounts with `account_suspended` (decision B7);
  - `src/indexer/handlers/stakes.ts` is W7-F1's this wave: the Stakes `onModeFinal` call at `RoundFinalized` goes in after the merge.
