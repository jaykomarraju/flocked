# Session W3-C (design): colour decisions + core round flow

**Role:** design. **Size:** M (split into `W3-C.2` if needed: the colour update and onboarding through Sealed first; Unsealing through Claims and the global states second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template), 4 (Global conventions) and 5.4 (Design track and freezes). Read nothing else in `plan.md`.
- `docs/plan/wave-3.md`: the intro, "W3-C" and "Changes from W2-Z". `docs/plan/wave-2.md` "P2.3" (naming, exports, inventory).
- `docs/sessions/W2-Z.md` (wave-2 summary), `docs/sessions/W2-C.md`, `docs/design/README.md` (conventions and "Paper MCP notes"), `docs/design/screens.md`.
- `Design_Language.md` (whole; short). Changed in wave 2 (Decision log, Oct 8, 2026): "Color tokens" (light `--muted` `#6E6E6E`, dark `--accent-ink` `#121212`, new `--scrim`, the accent-text rule), "Typography" (labels on accent), "Mascot" (dark mode), "Voice" (four new lines).
- Spec sections (Node 22: `nvm use` first), only the parts named: "Client app" (changed in wave 2: navigation, Stakes visibility), "Real-time and the reveal" (`--sub "Reveal choreography"`), "Modes: Free and Stakes", "Identity and personhood" (the first paragraph and the "Personhood (verified Coinbase sign-in)" Flow bullet), "Compliance and responsible play".
- Schemas, for the data each screen shows: `packages/shared/src/api/{rounds,entries,claims,me}.ts`, `packages/shared/src/ws.ts`.

## Objective
First apply the owner's colour decisions to the design foundations, then design every screen and state of the core round flow in Paper at mobile, tablet and desktop: onboarding (three cards); sign-in (Farcaster, wallet, email; inside the mini app and in the browser); Today (Free and Stakes; signed out and in; Stakes shown to unverified users with "Verify with Coinbase", hidden only for region, age and self-exclusion; the non-default config warning; the DST notice); sealing and submitting; Sealed (pick known, pick lost from local storage); the Unsealing countdown; Counting the flock; Reveal (win, loss, refund, Stakes provisional "Final at", mode toggle); "The next question is already live"; Stakes entry (verify with Coinbase, pending transaction, error, mismatch refusal); Claims (list, Claim all, empty, pending); and the global states (loading, error, offline, empty "The sheep are deliberating", blocked region, self-excluded). Use the five-tab navigation (Today, Archive, Boards, Rooms, You).

## Starting point
- Base: tag `wave-2`. Branch: `w3-c-design`. Worktree: `../flocked-w3-c`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w3-c -b w3-c-design wave-2
  cd ../flocked-w3-c && nvm use && pnpm install --frozen-lockfile
  ```
- First step: confirm the Paper MCP tools are visible and the file "Flocked" opens (`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`). If they're missing, stop as `blocked`.

## Scope and file ownership
- May create or edit: Paper pages `Foundations`, `Components` (colour update only) and `Core flow`; `packages/shared/design-tokens.json`; the `scrim` key in `packages/shared/src/tokens.ts` and `packages/shared/test/tokens.test.ts` (nothing else in those files); `docs/design/screens.md`; `docs/design/README.md`; `docs/design/exports/{foundations,components,core}/**`; `docs/sessions/W3-C.md`.
- Must not touch: application code, other `packages/shared` files, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P2.3: tokens JSON shape, Paper page names, artboard names `<surface>/<screen>/<state>/<breakpoint>`, exports at `docs/design/exports/<surface>/<screen>__<state>__<breakpoint>.png` (2x), inventory rows in `screens.md`. The CI step "Design tokens match the P2.3 schema" must stay green.

## Tasks
1. Create the worktree; confirm Paper (above).
2. Colour update, as its own commit: `muted` (light) `#6E6E6E`; add `scrim` (light `#141414` at 40%, dark `#000000` at 60%; pick a JSON form the schema can validate, e.g. 8-digit hex) to the JSON, the schema and its test; update the Paper tokens; redraw what changes on the Foundations colour artboard and the Components sheets that use `muted` or a scrim (forms-overlays at least); re-export them; check the accent-text rules on every sheet.
3. Core flow: every state above at `mobile`, `tablet` and `desktop` (desktop may centre the tablet layout, but needs its own artboard), named per P2.3, exported, with an inventory row. Motion notes for the reveal on the artboards.
4. Copy: use the Voice lines as written. Draft one refund line per refund reason (rules 1–8) on the reveal artboards and list them in the handoff for W3-Z to bring to the owner.
5. Open questions to decide and record: where the 30-day Stakes net result sits on Today; where the responsible-gambling link sits in Stakes onboarding.

## Tests and checks
- `pnpm --filter @flocked/shared exec vitest run test/tokens.test.ts`, `pnpm lint`, `pnpm test` and `pnpm format:check` green (Node 22).
- Every exported PNG exists at its P2.3 path at 2x; dark artboards use only dark tokens (the W2-C `find_nodes` check in `docs/design/README.md`).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- The colour decisions are in the JSON, the schema, Paper and the re-exported sheets. Every core-flow state has artboards at all three breakpoints, exports and inventory rows marked `review`. The refund lines are drafted. The handoff is written.

## Constraints
- Colour values come only from Design_Language.md as amended on Oct 8; anything else is a spec issue for Z.
- Don't edit the spec or the design language; record problems in the handoff. Don't fake owner actions (the freeze, OA-D2, is the owner's).
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, follow plan.md 2.6 (`W3-C.2`).

## End of session
1. Commit, then `git push -u origin w3-c-design`.
2. Write `docs/sessions/W3-C.md` from plan.md 3.2. Commit and push.
3. End with your status and: "When W3-A, B and C all report complete, start W3-D from `docs/prompts/W3-D.md`."
