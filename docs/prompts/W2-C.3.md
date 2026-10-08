# Session W2-C.3 (design): components, continued

**Role:** design. **Size:** M. **Model:** Opus 5.5. Continues W2-C.2 on the same branch.

**Precondition (owner):** the Paper MCP must accept writes again. W2-C.2 stopped on "Weekly MCP limit reached"
(Paper free plan, resets about Oct 9, 2026). Upgrade to Paper Pro, or wait for the reset, before starting.

## Read first
- `docs/sessions/W2-C.md` (status, the components work so far, and "Notes for D and Z" on the Paper MCP,
  including the call budget).
- `docs/design/README.md` and `docs/design/screens.md` (the Components table is your work list).
- `docs/plan/wave-2.md`: "Pinned interfaces" P2.3 and section "W2-C" (the "Components" list).
- `Design_Language.md` (all) and `packages/shared/src/copy.ts`.
- `plan.md` section 3.2 (handoff template) only.
- Spec: `pnpm spec "Client app"` (the screen table only), and the Decision log row about the voice lines
  (`pnpm spec "Out of scope, launch gates and decision log" | grep -n 'voice lines'`): whole percent, winning
  share rounded down, losing share rounded up, "<1%" and ">99%" at the extremes.

## Objective
Finish the `Components` page of the Paper file "Flocked": the seven sheets W2-C.2 didn't reach, each with a light
and a dark artboard. Then export all nine sheets and update the inventory, so the owner can review Foundations
and Components together for freeze OA-D1.

## Starting point
- Branch `w2-c-design`, worktree `../flocked-w2-c`.
  cd ../flocked-w2-c && git status && git log --oneline -3
- Paper: `get_guide({ topic: "paper-mcp-instructions" })`, then
  `open_file({ fileId: "01M4C8WJPZXED0ZQH8RZTPN57G" })`. If a write returns "Weekly MCP limit reached", stop as
  `blocked` again and say so.
- Already on the `Components` page (built, not exported): `components/option-card/{light,dark}/desktop` and
  `components/actions/{light,dark}/desktop`. An empty artboard `components/stake-selector/light/desktop` exists;
  build into it rather than creating a second one.
- Match the two finished sheets: 1120 wide, 64px padding, a `Header` (eyebrow "Flocked · Components · n of 9",
  Fredoka 700 56px title, Inter 16px description, 2px ink bottom rule; duplicate an existing `Header` into the new
  artboard and set its text), then sections split by 1.5px `line` rules. Specimen cells are 320 wide (three per
  row) or a 176px label column plus four 188px cells. State names in Inter 600 16px, notes in Inter 13px ink.

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
Build the sheets in this order, each light first, then dark:
1. `stake-selector`: Free presets (10, 25, 50, 100) + slider (10–100 points; a preset above the balance is
   disabled and the slider max drops to the balance); Stakes fixed stake (5 USDC, same for everyone this round).
2. `round-status`: countdown, entrant/pool counter, padlock sealed badge, split bars (equal, end states, win accent).
3. `result-card`: unflocked (accent result line), got flocked (monochrome), refunded, provisional with "Final at"
   time. Copy from `winLine`/`lossLine` with the Decision log rounding (option-card uses a 38.6 / 61.4 split:
   38% and 62%).
4. `feedback`: toast/error, empty state (neutral sheep), skeleton loading, offline banner.
5. `lists`: list row, leaderboard row (including "you" and an accent stray-streak highlight), avatar.
6. `forms-overlays`: form field (text, focus, error), modal, bottom sheet.
7. `navigation`: mobile nav bar, desktop header.
Then export all 18 artboards at 2x (including option-card and actions), move them to the P2.3 paths, tidy the
canvas (one row per sheet: light at x 0, dark at x 1200), flip the `screens.md` rows to `review`, and finish the
handoff.

## Tests and checks
- Every component has light and dark artboards, and the dark ones use `--color-dark-*` only (on each dark
  artboard, `find_nodes` for each light token, e.g. `--color-ink`, returns nothing).
- The contrast rules in `screens.md` hold: no light-muted body text, labels on accent are `cta` role or larger,
  accent text is ≥ 24px, and interactive boundaries use ink.
- `pnpm format:check` passes.

## Definition of done
- All nine sheets are built and exported, `screens.md` is complete, and the handoff says `complete`. The owner can
  review Foundations and Components in Paper. The freeze itself is OA-D1.

## Constraints
- Design only: no application code. Record spec problems in the handoff's "Spec issues".
- Stage files by name. Commits end with the attribution line from your system reminder.
- Spend Paper calls carefully (see the handoff's call budget). Stay within size M. If running low, stop at a
  green commit after a finished sheet, and emit `W2-C.4` (plan.md 2.6).

## End of session
1. Commit, then `git push origin w2-c-design`.
2. Update `docs/sessions/W2-C.md` (plan.md 3.2): status, the components work, and any new spec issues. Commit and
   push.
3. End with your status and: "When W2-A, B and C all report complete, start W2-D from `docs/prompts/W2-D.md`."
