# Wave 8: Content, social and the web shell

**Goal.** The question pipeline (submit, moderation, vote, queue, creator credit), stats and boards, and rooms exist on the backend. The web app shell is built from the frozen foundations, with sign-in working in the browser and inside the mini app.

**Base.** Tag `wave-7`. **Hold point:** OA-D1 (foundations frozen) before W8-C. **Migrations reserved:** W8-A `0017`, W8-B `0018`, W8-D `0019`.

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
- **Objective.** Merge A, B and C. Build rooms:
  - `POST /rooms`, `POST /rooms/join`, `GET /rooms/:id`, `POST /rooms/:id/questions` (moderated via W8-A);
  - room rounds created by the scheduler (mirror or custom), one RoundDO per room round;
  - room points (500 on join, +100 per room round under 1,000) via `src/points`;
  - qualification of ≥ 3 distinct qualifying entrants with accounts ≥ 24 h old at `closesAt`, recorded per entry in the members-only bundle;
  - the room leaderboard (room points, wins this week, streaks);
  - member picks after the reveal;
  - excluded from global stats and referrals;
  - the Stakes-rooms flag (off), with tickets restricted when it's on.
- **Read first.** `plan.md` §2, §3.4. Handoffs W8-A, B, C. Spec: "Profiles, leaderboards and rooms" (only "Rooms"), "API" (room rows).
- **Owns.** Registry files; `apps/api/src/rooms/**`; `apps/api/src/routes/rooms.ts`; migration `0019`; `apps/api/test/rooms/**`; `e2e/tests/rooms.spec.ts`.
- **Required tests.** Non-member entry and view rejected. Room minimum refund. Room rounds never touch global stats. A room round settles on the local stack.
- **Emits.** W8-Z prompt.

## W8-Z checklist

- Moderation and boards tests named; UI screenshot suite green in CI.
- Confirm OA-D2 is frozen before W9-C.
- Migrations for wave 9: W9-A `0020`, W9-B none, W9-D `0021`.

## Carry-over from W2-Z (Oct 8, 2026)

- **W8-B:** the CHECK `best_stray_streak >= stray_streak` means both columns change in one `UPDATE`.
- **W8-C:** navigation is five tabs: Today, Archive, Boards, Rooms, You; Submit, Queue, Claims and Settings under You on mobile and in the header on desktop (plus Questions) (Decision log, Oct 8). W8-C also builds the placeholder mascot React components in `packages/shared/mascot` from the Paper `sheep/*` layers (Design_Language "Mascot").

## Carry-over from W3-Z (Oct 9, 2026)

- **W8-D:** room-round grants (owner decision, Oct 9): +100 room points per room round below a room balance of 1,000, ledger reason `room_grant`. A skip is final for that round and recorded in `daily_grant_skips`, keyed by the round. Reuse `src/rounds/grant.ts`.
- **W8-B:** the crowd-history hint (Client app, Today; Oct 9): the category's average winning-side share over its last 30 settled daily rounds, hidden below 5. Expose it on `GET /rounds/today`.
