# Session W6-C.2 (design): share sheet, share page and notifications

**Role:** design. **Size:** M. **Model:** Opus 5.5. Continues W6-C on the same branch (`w6-c-design`, worktree
`../flocked-w6-c`). W6-C drew every share card (result, refund, streak, teaser, round in `og`, `embed` and
`square`); this part does the rest of the W6-C objective.

## Read first
- `docs/sessions/W6-C.md` (the W6-C handoff: what's drawn, card decisions, spec issues, and "Notes for W6-C.2" with
  the notification-copy groundwork).
- `docs/prompts/W6-C.md` (the original prompt: objective, scope, pinned interfaces, constraints all still apply).
- `docs/design/README.md` (pages, naming, exports incl. the card-frame rule, conventions, "Paper MCP notes") and
  `docs/design/screens.md` (the "Cards and notifications" section and its decisions).
- `Design_Language.md` (whole; short).
- `plan.md` section 3.2 (handoff template) only.
- Spec (Node 22: `nvm use` first): `pnpm spec "Share cards and distribution"`, `pnpm spec "Notifications"`, and the
  Oct 12 Decision log rows (`pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 12'`).
- Schemas: `packages/shared/src/api/cards.ts`, `packages/shared/src/queues.ts` (`NotifyMessageSchema`,
  `SECURITY_NOTICE_KINDS`), `NOTIFICATION_EVENTS` in `packages/shared/src/enums.ts`, `NOTIFICATION_CHANNELS` in
  `packages/shared/src/api/me.ts`, `packages/shared/src/copy.ts`, `packages/shared/src/reasons.ts`.

## Objective
In the Paper page `Cards and notifications`:
- **The share sheet** (Farcaster cast composer in the mini app, native Web Share, copy link, download image; closes
  with a "Not now" text button) for a result and for the pre-reveal teaser, at `mobile`, `tablet` and `desktop`.
- **The OG landing page** `/s/:shareId` (result share; teaser before and after the reveal, which links to the round),
  at `mobile`, `tablet` and `desktop`, with the OG and Farcaster embed meta noted on the artboards.
- **Notifications:** copy for every event in `NOTIFICATION_EVENTS` on each channel (Farcaster, web push, email),
  the refund lines for rules 4, 7 and 8 included, as `notifications/*` artboards, plus the email templates.

Then write the final notification copy as data in `packages/shared/src/copy/notifications.ts`, keyed by event and
channel, with its test `packages/shared/test/copy-notifications.test.ts`.

## Starting point
```bash
cd ../flocked-w6-c && git pull && nvm use && pnpm install --frozen-lockfile
```
First step: confirm the Paper MCP tools are visible and the file "Flocked" opens
(`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`). If they're missing, stop as `blocked`.

## Scope and file ownership
- May create or edit: Paper page `Cards and notifications` (not the card artboards W6-C drew, except to fix a
  defect you record); `docs/design/screens.md` (cards and notifications sections);
  `docs/design/exports/cards/**`, `docs/design/exports/notifications/**`; `packages/shared/src/copy/notifications.ts`
  (new) and `packages/shared/test/copy-notifications.test.ts` (new); `docs/design/README.md` (only conventions this
  surface needs); `docs/sessions/W6-C.md` (update it to cover both parts).
- Must not touch: application code, every other `packages/**` file (including `packages/shared/src/index.ts`; the
  export goes in "Notes for D and Z"), the other Paper pages, `Product_Spec.md`, `Design_Language.md`, `plan.md`,
  `docs/plan/`.

## Pinned interfaces
- P2.3 naming and exports, as in `docs/prompts/W6-C.md`. Share sheet and share page artboards use the screen
  breakpoints (`cards/share-sheet/<state>/<breakpoint>`, `cards/share-page/<state>/<breakpoint>`); notification
  artboards are `notifications/<screen>/<state>/<breakpoint>` and export to `exports/notifications/`.
- Tokens frozen (OA-D1); kit decisions of Oct 12 (captions in the type table, secondary pills with the surface fill,
  a selected segment gets a check, optional sheets close with "Not now").
- Events from `NOTIFICATION_EVENTS`, channels from `NOTIFICATION_CHANNELS`, card kinds and variants from `cards.ts`.
  A missing event or field is a spec issue, not a new enum value.

## Tasks
1. Share sheet and `/s/:shareId` at all three breakpoints, reusing the reveal screen's share-card preview and the
   Core flow sheet/modal pattern; exported, inventory rows marked `review`.
2. Notification artboards: one per channel listing every event (and its variants: outcome win, loss, void, refund
   by reason; refunded by reason and mode; question_used stages; security notice kinds), marking events not sent on
   a channel; the refund lines for rules 4, 7 and 8; the email templates at `mobile` and `desktop`. Exported, rows
   marked `review`.
3. `copy/notifications.ts`: the copy as data, typed against `NOTIFICATION_EVENTS` and `NOTIFICATION_CHANNELS`. Its
   test checks that every event × channel has copy or is marked not sent on that channel (matching the spec's
   channel column), that no line has an exclamation point, and that filled lines fit the Farcaster limits.
4. Use the Voice lines as written. List every new line in the handoff for W6-Z to bring to the owner, and record
   open questions with your recommendation.

## Tests and checks
- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm format:check` green (Node 22).
- Every exported PNG exists at its P2.3 path at 2x.

## Definition of done
- The share sheet, `/s/:shareId`, every notification channel and the email templates have artboards, exports and
  inventory rows marked `review`; refund copy covers rules 4, 7 and 8.
- `copy/notifications.ts` holds the copy for every event and channel, with its test. `docs/sessions/W6-C.md` covers
  both parts with status `complete`.

## Constraints
- Colour and type values only from `Design_Language.md`. Don't edit the spec or the design language; record problems
  in the handoff. Don't fake owner actions (the review and the OA-D4 freeze are the owner's).
- Stage files by name. Commits end with the attribution line from your system reminder.

## End of session
1. Commit, then `git push`.
2. Update `docs/sessions/W6-C.md` from plan.md 3.2. Commit and push.
3. End with your status and: "When W6-A, B and C all report complete, start W6-D from `docs/prompts/W6-D.md`."
