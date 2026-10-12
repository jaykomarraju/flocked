# Session W6-C (design): share cards and notifications

**Role:** design. **Size:** M (split into `W6-C.2` if needed: the result, refund, streak, teaser and round cards in all three variants first; the share sheet, `/s/:shareId`, notification copy, `copy/notifications.ts` and the email templates second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 5.4 (Design track and freezes). Read nothing else in `plan.md`.
- `docs/plan/wave-6.md`: the intro, "Pinned interfaces", "W6-C", and the W6-C and "All" items of every "Carry-over" section (only W5-Z has them).
- `docs/sessions/W5-Z.md` (wave-5 summary).
- Design files:
  - `docs/design/README.md`: pages, artboard names, exports, the contrast rules, the component and screen conventions, "Paper MCP notes";
  - `docs/design/screens.md`: the inventories and decisions so far;
  - `Design_Language.md` (whole; especially "Share cards").
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Share cards and distribution"
  pnpm spec "Notifications"
  ```
  Changed in wave 5 (Decision log, Oct 12, 2026): "Settlement and payout math" (Refund rules: Free refunds by rules 7 and 8 are real outcomes, and every Free refund writes `refund` payouts), "Profiles, leaderboards and rooms" (Leaderboards: the Streaks board ranks the best stray streak and shows the current one) and "Client app" (Round detail shows one result box per mode played). Read the Oct 12 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 12'`.
- Schemas, for what each card and message carries: `packages/shared/src/api/cards.ts` (`CARD_KINDS`, `CARD_VARIANTS`), `packages/shared/src/queues.ts` (`NotifyMessageSchema`), `NOTIFICATION_EVENTS` in `packages/shared/src/enums.ts`, `NOTIFICATION_CHANNELS` in `packages/shared/src/api/me.ts`, and `packages/shared/src/copy.ts` (the Voice lines already in code).

## Objective
Design, in Paper:
- **Share cards:** the result card (win, loss, refund) for Free and Stakes, with amounts shown or the multiple only; the streak card (streak ≥ 2); the teaser; the generic round card. Each in all three variants, `og` 1200×630, `embed` 1200×800 and `square` 1080×1080, and proven legible at 25 % scale.
- **Refund cards** for every refund outcome, including Free rules 7 (commitment not anchored) and 8 (beacon unavailable), like rule 4 (W5-Z carry-over).
- **The share sheet** and **the OG landing page** `/s/:shareId`, at mobile, tablet and desktop.
- **Notifications:** copy for every event per channel (Farcaster, web push, email), refunds by rules 4, 7 and 8 included, and the email templates.

Then write the final notification copy as data in `packages/shared/src/copy/notifications.ts`, keyed by event and channel.

## Starting point
- Base: tag `wave-5`. Branch: `w6-c-design`. Worktree: `../flocked-w6-c`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w6-c -b w6-c-design wave-5
  cd ../flocked-w6-c && nvm use && pnpm install --frozen-lockfile
  ```
- First step: confirm the Paper MCP tools are visible and the file "Flocked" opens (`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`). If they're missing, stop as `blocked`.

## Scope and file ownership
- May create or edit:
  - Paper page `Cards and notifications` (new);
  - `docs/design/screens.md`: the cards and notifications sections;
  - `docs/design/exports/cards/**` and `docs/design/exports/notifications/**`;
  - `packages/shared/src/copy/notifications.ts` (new, next to the existing `copy.ts`, which you don't edit) and its test `packages/shared/test/copy-notifications.test.ts`;
  - `docs/design/README.md`, only for the new conventions this surface needs (the `notifications` surface, card variants as breakpoints);
  - `docs/sessions/W6-C.md`.
- Must not touch: application code, every other `packages/**` file (including `packages/shared/src/index.ts` and `design-tokens.json`; the export of your copy module goes in "Notes for D"), the `Foundations`, `Components`, `Core flow`, `Social` and `Admin` pages, `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- P2.3 (`docs/plan/wave-2.md`):
  - the Paper page names;
  - artboard names `<surface>/<screen>/<state>/<breakpoint>`; for cards, the breakpoint is the `CARD_VARIANTS` name (`og`, `embed`, `square`);
  - exports at `docs/design/exports/<surface>/<screen>__<state>__<breakpoint>.png` (2x);
  - inventory rows in `screens.md`.
- The tokens are frozen (OA-D1). Use only existing tokens and components; a missing one is a spec issue for Z.
- Follow the kit decisions of Oct 12, which W7-C applies to `Components` later (`wave-7.md`, "Carry-over from W5-Z"): captions use the type table (Inter 500, muted); secondary pills have the surface fill; a selected segment gets a check; optional sheets, the share sheet included, close with a "Not now" text button.
- Card kinds and variants come from `cards.ts`, events from `NOTIFICATION_EVENTS`, channels from `NOTIFICATION_CHANNELS`. A missing kind or event is a spec issue, not a new enum value.
- Note for W10-A: satori renders the cards and supports a subset of CSS (flexbox, no grid). Design within it, and put a note on each card artboard naming its layout primitives.

## Tasks
1. Create the worktree, and confirm Paper (above).
2. Cards: every kind and state in the Objective, in `og`, `embed` and `square`, named per P2.3 and exported at 2x, with the satori note on each artboard. Check each at 25 % scale and record how in `screens.md`. Reveal gating covers cards: a teaser or round card shows no per-option data.
3. Refund cards: Free rules 1–3, 4 (void), 7 and 8; Stakes refunds (rules 1–3, 4, 5 and 6). Each says why in one line, in the Voice.
4. The share sheet and `/s/:shareId` at `mobile`, `tablet` and `desktop`.
5. Notifications: each event in `NOTIFICATION_EVENTS` on each channel, the refund lines for rules 4, 7 and 8 (`outcome` and `refunded` carry `refundReason`), and the email templates as artboards, exported under `exports/notifications/`.
6. `copy/notifications.ts`: the copy as data, typed against `NOTIFICATION_EVENTS` and `NOTIFICATION_CHANNELS`. Its test checks that every event × channel has copy or is marked not sent on that channel, and that no line has an exclamation point.
7. Copy: use the Voice lines as written. List every new line in the handoff, for W6-Z to bring to the owner. Record open questions, each with your recommendation.

## Tests and checks
- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm format:check` green (Node 22).
- Every exported PNG exists at its P2.3 path at 2x. Dark artboards use only dark tokens (the `find_nodes` check in `docs/design/README.md`).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Every card kind, state and variant, the share sheet, `/s/:shareId` and the email templates have artboards, exports and inventory rows marked `review`. Refund cards and copy cover rules 4, 7 and 8.
- `copy/notifications.ts` holds the copy for every event and channel, with its test. The handoff is written.

## Constraints
- Colour and type values come only from `Design_Language.md`; anything else is a spec issue for Z.
- Don't edit the spec or the design language; record problems in the handoff. Don't fake owner actions: the review and freeze (OA-D4) are the owner's.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W6-C.2`).

## End of session
1. Commit, then `git push -u origin w6-c-design`.
2. Write `docs/sessions/W6-C.md` from plan.md 3.2. Put the `index.ts` export under "Notes for D and Z". Commit and push.
3. End with your status and: "When W6-A, B and C all report complete, start W6-D from `docs/prompts/W6-D.md`."
