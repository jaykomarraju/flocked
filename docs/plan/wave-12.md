# Wave 12: Remaining UI and analytics

**Goal.** Every screen in the spec's Client app table exists and matches the frozen design, and the admin console works. Analytics events flow to Workers Analytics Engine, with a dashboard. Every remaining e2e scenario passes.

**Base.** Tag `wave-11`. **Hold points:** OA-D3 and OA-D5 frozen; OA-21 ToS/privacy/responsible-play text available for W12-B (if not, W12-B uses clearly marked placeholder text, and the item stays open in PR-11). **Migrations reserved:** W12-D `0026`.

## W12-A: Web submit, queue, rooms

- **Role / size:** build (UI), M.
- **Objective.** Build `/submit` (live format validation, moderation result, 3/day, blocked-for-7-days state), `/queue` (top 50, up/down votes), and `/rooms` + `/rooms/:id` (create, invite link, join via code, room round with room points and stake, member picks after reveal, room leaderboard).
- **Read first.** `plan.md` §2. `docs/sessions/W11-Z.md`. `docs/design/screens.md` (submit, queue, rooms rows), the exports, those artboards. Spec: "Client app" (those rows).
- **Owns.** `apps/web/src/features/{submit,queue,rooms}/**`, `e2e/ui/{submit,queue,rooms}.spec.ts`.
- **Required tests.** Screenshots; axe; a room round played in the UI on the local stack.

## W12-B: Web settings and responsible play

- **Role / size:** build (UI), M.
- **Objective.** Build `/settings`:
  - linked identities with link and unlink rules, and pending merges with confirm;
  - Coinbase verification;
  - creator payout wallet (with its eligibility rules);
  - card and profile privacy;
  - notification prefs;
  - stake cap (pending increase shown);
  - self-exclusion (timed and permanent, no shortening, lift request after 6 months);
  - delete account (unclaimed payouts listed, "Claim all");
  - sign out;
  - the persistent responsible-gambling link;
  - the ToS and age attestation flow, and the ToS and privacy pages.
- **Read first.** `plan.md` §2. `docs/sessions/W11-Z.md`. `docs/design/screens.md` (settings rows), the exports, those artboards. Spec: "Client app" (Settings row), "Compliance and responsible play".
- **Owns.** `apps/web/src/features/{settings,legal}/**`, `apps/web/src/content/legal/**`, `e2e/ui/settings.spec.ts`.
- **Required tests.** Screenshots; axe; each identity and limits flow against the local stack.

## W12-C: Web admin console

- **Role / size:** build (UI), M.
- **Objective.** Build `/admin` per the Paper Admin page over the W11-A API: schedule, queue, live round, interventions with confirmations, challenge window, users, and flags/config. The analytics tab is a placeholder that W12-D fills.
- **Read first.** `plan.md` §2. `docs/sessions/W11-Z.md`. `docs/design/screens.md` (admin rows), the exports, those artboards. Spec: "Admin console".
- **Owns.** `apps/web/src/features/admin/**` (except `analytics/`), `e2e/ui/admin.spec.ts`.
- **Required tests.** Screenshots; axe; an admin-only route guard; a void-before-close flow on the local stack.

## W12-D: Analytics + remaining e2e

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C. Analytics: server events (`signup`, `entry_submitted`, `share_landing`, `share_conversion`, `question_submitted`, `question_voted`, `personhood_verified`, `claim_completed`, `notification_sent`) and client beacon events (`page_view`, `reveal_viewed`, `share_clicked`, `notification_opened`) to Analytics Engine, with no plaintext picks. The admin analytics tab shows the spec's dashboard metrics via the AE SQL API, plus the Free extra-accounts flag query (Anti-abuse). Remaining e2e: E2E-7 / AC-9 (question → moderation → vote → approve → schedule → settle → creator award/fee), E2E-9 (UI), E2E-12, E2E-13.
- **Read first.** `plan.md` §2, §3.4. Handoffs W12-A, B, C. Spec: "Analytics", "Anti-abuse" (Free-mode extra accounts bullet).
- **Owns.** Registry files; `apps/api/src/analytics/**`; `apps/web/src/analytics/**`; `apps/web/src/features/admin/analytics/**`; migration `0026` if needed; `e2e/ui/{question-flow,exclusion,delete-account,question-block}.spec.ts`.
- **Required tests.** E2E-7, E2E-9, E2E-12, E2E-13, AC-9. Analytics payloads never include option data (test).
- **Emits.** W12-Z prompt.

## W12-Z checklist

- Every E2E row is proven. Every screen in `docs/design/screens.md` has a passing screenshot test, or a recorded reason.
- Confirm OA-04, OA-14 and OA-15 (staging keys) are in progress; wave 13's deploy pipeline and wave 14's staging need them.
