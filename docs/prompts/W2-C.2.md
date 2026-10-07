# Session W2-C.2 (design): components

**Role:** design. **Size:** M. **Model:** Opus 5.5. Continues W2-C on the same branch.

## Read first
- `docs/sessions/W2-C.md` (the W2-C handoff, including "Notes for D and Z" on working with the Paper MCP).
- `docs/design/README.md` and `docs/design/screens.md` (the Components table is your work list).
- `docs/plan/wave-2.md`: "Pinned interfaces" P2.3 and section "W2-C" (the "Components" list).
- `Design_Language.md` (all) and `packages/shared/src/copy.ts`.
- `plan.md` section 3.2 (handoff template) only.
- Spec: `pnpm spec "Client app"` (the screen table only), and the Decision log row about the voice lines
  (`pnpm spec "Out of scope, launch gates and decision log" | grep -n 'voice lines'`): whole percent, winning
  share rounded down, losing share rounded up, "<1%" and ">99%" at the extremes.

## Objective
Build the `Components` page of the Paper file "Flocked": every component in wave-2.md "W2-C", each sheet with a
light and a dark artboard, using the foundations and tokens W2-C made. Export the PNGs and update the
inventory, so the owner can review Foundations and Components together for freeze OA-D1.

## Starting point
- Branch `w2-c-design`, worktree `../flocked-w2-c` (it already exists, with `node_modules` installed).
  ```bash
  cd ../flocked-w2-c && git status && git log --oneline -3
  ```
- Paper: `get_guide({ topic: "paper-mcp-instructions" })`, then
  `open_file({ fileId: "01M4C8WJPZXED0ZQH8RZTPN57G" })`. The file's design tokens (`--color-*`,
  `--color-dark-*`, `--text-*`, `--spacing-*`, `--radius-*`) already exist. Use them as CSS variables. If the
  Paper tools are missing, stop as `blocked` on OA-02.

## Scope and file ownership
- May create or edit: the Paper file's `Components` page; `docs/design/screens.md` (Components section, and
  flipping rows to `review`); `docs/design/exports/components/**`; `docs/design/README.md`;
  `docs/sessions/W2-C.md` (update it to `complete`).
- Must not touch: the `Foundations` page (unless a component exposes a foundation bug, which you then record in
  the handoff), other Paper pages, any code, `packages/shared/design-tokens.json` (unless a component needs a new
  type role or motion token, recorded as a deviation), `Product_Spec.md`, `Design_Language.md`, `plan.md`,
  `docs/plan/`.

## Pinned interfaces
- P2.3: artboard names `components/<sheet>/<light|dark>/desktop` (1120 wide), exports at 2x to
  `docs/design/exports/components/<sheet>__<light|dark>__desktop.png`, the inventory columns.

## Tasks
Build the sheets in this order (the order in `screens.md`), each light first, then dark:
1. `option-card`: idle, hover, pressed, selected (ink fill, bg text), disabled, revealed-win (accent), revealed-loss
   (monochrome), with headcount % in the `numberXL` role.
2. `actions`: primary CTA pill ("Seal my pick", `cta` role on accent), secondary pill, mode toggle (Free/Stakes,
   and Stakes hidden), tabs.
3. `stake-selector`: Free presets + slider; Stakes fixed stake.
4. `round-status`: countdown, entrant/pool counter, padlock sealed badge, split bars (equal, end states, win accent).
5. `result-card`: unflocked (accent result line), got flocked (monochrome), refunded, provisional with "Final at"
   time. Copy from `winLine`/`lossLine` with the Decision log rounding.
6. `feedback`: toast/error, empty state (neutral sheep), skeleton loading, offline banner.
7. `lists`: list row, leaderboard row (including "you" and an accent stray-streak highlight), avatar.
8. `forms-overlays`: form field (text, focus, error), modal, bottom sheet.
9. `navigation`: mobile nav bar, desktop header.
Then export all artboards at 2x, move them to the P2.3 paths, flip the `screens.md` rows to `review`, and finish
the handoff.

## Tests and checks
- Every component has light and dark artboards, and the dark ones use `--color-dark-*` only.
- The contrast rules in `screens.md` hold: no light-muted body text, labels on accent are `cta` role or larger,
  accent text is ≥ 24px, and interactive boundaries use ink.
- `pnpm format:check` passes.

## Definition of done
- All nine sheets are built and exported, `screens.md` is complete, and the handoff says `complete`. The owner can
  review Foundations and Components in Paper. The freeze itself is OA-D1.

## Constraints
- Design only: no application code. Record spec problems in the handoff's "Spec issues".
- Stage files by name. Commits end with the attribution line from your system reminder.
- Stay within size M. If running low, stop at a green commit after a finished sheet, and emit `W2-C.3`
  (plan.md 2.6).

## End of session
1. Commit, then `git push origin w2-c-design`.
2. Update `docs/sessions/W2-C.md` (plan.md 3.2): status, the components work, and any new spec issues. Commit and
   push.
3. End with your status and: "When W2-A, B and C all report complete, start W2-D from `docs/prompts/W2-D.md`."
