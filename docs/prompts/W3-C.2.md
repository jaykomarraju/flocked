# Session W3-C.2 (design): core round flow, part 2

**Role:** design. **Size:** M. **Model:** Opus 5.5. Continues W3-C on the same branch (`w3-c-design`, worktree
`../flocked-w3-c`).

## Read first
- `docs/sessions/W3-C.md` (the W3-C handoff: what's drawn, decisions, refund lines, spec issues).
- `docs/design/README.md` ("Screen conventions (Core flow)" and "Paper MCP notes") and `docs/design/screens.md`
  (the Core flow table and "Core flow decisions").
- `Design_Language.md` (whole; short).
- `plan.md` section 3.2 (handoff template) only.
- Spec (Node 22: `nvm use` first), only these: `pnpm spec "Real-time and the reveal" --sub "Reveal choreography"`,
  `pnpm spec "Client app"` (Reveal, Claims and Settings rows; Entry flow (Stakes)), `pnpm spec "Modes: Free and
  Stakes"` ("Rules shared by both modes"), `pnpm spec "Compliance and responsible play"`.
- Schemas: `packages/shared/src/api/{rounds,claims,entries}.ts`, `packages/shared/src/ws.ts`,
  `packages/shared/src/reasons.ts` (refund codes 1–8).

## Objective
Finish the core round flow in the Paper page `Core flow`, at mobile, tablet and desktop: the Unsealing countdown;
Counting the flock; Reveal (win, loss, refund, Stakes provisional "Final at", mode toggle) with motion notes on the
artboards and one refund line per refund reason (rules 1–8, drafts in the W3-C handoff); "The next question is
already live"; Stakes entry (the verification sheet with the "Responsible play" link, pending transaction, error,
mismatch refusal); Claims (list, Claim all, empty, pending); and the global states (loading, error, offline, empty
"The sheep are deliberating", blocked region, self-excluded).

## Starting point
```bash
cd ../flocked-w3-c && git pull && nvm use && pnpm install --frozen-lockfile
```
First step: confirm the Paper MCP tools are visible and the file "Flocked" opens
(`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`). If they're missing, stop as `blocked`.

## Scope and file ownership
- May create or edit: Paper page `Core flow`; `docs/design/screens.md`; `docs/design/README.md`;
  `docs/design/exports/core/**`; `docs/sessions/W3-C.md` (update it to cover both parts).
- Must not touch: application code, `packages/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P2.3: artboard names `core/<screen>/<state>/<breakpoint>`, exports at
  `docs/design/exports/core/<screen>__<state>__<breakpoint>.png` (2x), one inventory row per state in `screens.md`.

## Tasks
1. Reuse what W3-C drew: Today/Sealed `content` frames, headers, nav bar and the component sheets (clone sources are
   listed in the W3-C handoff). Rows continue on the canvas below y 16800, every 1200.
2. Draw every state above at all three breakpoints, named per P2.3, exported (one `export` call at a time), with an
   inventory row marked `review`.
3. Reveal: motion notes on the artboards (bars equal → shares over 3s ease-out, winner fills with the accent, result
   card springs up; reduced motion skips to the end with a fade). Put the eight refund lines on the refund artboards;
   W3-Z brings them to the owner.
4. Use the Voice lines as written; list any new copy in the handoff.

## Tests and checks
- `pnpm lint`, `pnpm test` and `pnpm format:check` green (Node 22).
- Every PNG exists at its P2.3 path at 2x (760 / 1536 / 2240 wide).

## Definition of done
- Every core-flow state from the W3-C prompt has artboards at all three breakpoints, exports and inventory rows marked
  `review`. Refund lines are on the reveal artboards. `docs/sessions/W3-C.md` covers both parts with status `complete`.

## Constraints
- Colour values only from Design_Language.md. The accent appears only where Design_Language allows it.
- Stage files by name. Commits end with the attribution line from your system reminder.

## End of session
1. Commit, then `git push`.
2. Update `docs/sessions/W3-C.md` from plan.md 3.2. Commit and push.
3. End with your status and: "When W3-A, B and C all report complete, start W3-D from `docs/prompts/W3-D.md`."
