# Session W9-C.2: Sealed and Reveal screenshots

**Role:** build (UI). **Size:** M (subagent tokens count: one builder at a time, at most two in all). **Model:**
Opus 5.5. Continues W9-C on the same branch (`w9-c-today`, worktree `../flocked-w9-c`). W9-C built the whole Free
flow (WS client, entry flow, Today, Sealed, the reveal with its motion) and matched the Today artboards; this part
matches the Sealed and Reveal screens to their Paper artboards and adds their sheets and screenshot tests.

## Read first
- `docs/sessions/W9-C.md` (the W9-C handoff: what exists, deviations, "Notes for W9-C.2").
- `docs/prompts/W9-C.md` (the original prompt: scope, file ownership, pinned interfaces and constraints all still
  apply).
- `plan.md` section 3.2 (handoff template) only.
- `docs/design/README.md`, `docs/design/screens.md` "Core flow" (the `core/sealed/*` and `core/reveal/*` rows and
  the W3-C.2 decisions: notes bands, reveal layout, accent on a loss, unsealing, refunds without a tally, mode
  toggle, next question live), `Design_Language.md` "Motion" and "Voice".
- `e2e/ui/README.md` (Screenshots), `e2e/fixtures/screenshot.ts`, and W9-C's sheet `apps/web/src/sheets/core/
  today.sheet.tsx` with `sheets/core/frames.tsx` (how a Core-flow screen is drawn in the real shell).
- Code you match: `apps/web/src/features/sealed/SealedView.tsx`, `apps/web/src/features/reveal/{RevealView,
  ShareBlock,LastRoundStrip}.tsx` and their CSS modules; `ui/SplitBars.tsx` (W9-C added `pick` and `display`).
- The exports and, through the Paper MCP, only these artboards (read only).

## Objective
Sheets and `@screenshot` tests, within `maxDiffPixelRatio` 0.01, for:
- `core/sealed/{pick-known,pick-lost}/{mobile,tablet,desktop}`;
- `core/reveal/{unsealing,counting,win,loss,refund,mode-toggle,next-live}/{mobile,tablet,desktop}`
  (`provisional` is Stakes: W10-C).

The win, loss, refund and mode-toggle artboards end in a notes band (part of the export): the sheet draws it. The
Sealed and Reveal artboards don't draw the mode-toggle check yet while the app's toggle does (W9-Z's design pass adds
it): expect that region to differ within the tolerance, and say so in the handoff. `next-live` is Today for the next
round with the "Last round" strip (`TodayView` `lastRound`). Fix the views' CSS (and the props, backwards compatible)
until they match; the live screen (`features/today/Today.tsx`) and its tests must keep passing.

## Scope and file ownership
As W9-C: `apps/web/src/features/{today,sealed,reveal}/**`, `apps/web/src/sheets/**`, `e2e/ui/{sealed,reveal}.spec.ts`
(add the screenshot block at the top; keep the browser tests). `ui/**` only for a fix you name in the handoff.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22). `pnpm e2e:screens` green on macOS (W8-C's 38, W9-C's 12
  Today sheets and yours). `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` green on a fresh stack (isolated ports
  if another session runs a stack: plan.md 4.3).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations.

## End of session
1. Commit, then `git push origin w9-c-today`.
2. Update `docs/sessions/W9-C.md` (status, files, tests, deviations; keep it ≤ ~120 lines), then commit and push.
3. End with your status and: "When W9-A, W9-B, W9-C and W8-F1 all report complete, start W9-D from
   `docs/prompts/W9-D.md`."
