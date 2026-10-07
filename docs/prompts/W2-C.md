# Session W2-C (design): foundations and components

**Role:** design. **Size:** M. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 5.4 (Design track and freezes). Read nothing else in `plan.md`.
- `docs/plan/wave-2.md`: the intro, "Pinned interfaces" P2.3, and section "W2-C".
- `docs/sessions/W1-Z.md` (wave-1 summary).
- `Design_Language.md` (all).
- Spec sections, loaded with `pnpm spec "<heading>"`: "Client app" (the screen table only); "Overview" with `--sub "Brand vocabulary"`.
- The Decision log row added in wave 1 about the win and loss voice lines (`pnpm spec "Out of scope, launch gates and decision log" | grep -n 'voice lines'`): whole percent, the winning share rounded down and the losing share rounded up, "<1%" and ">99%" at the extremes. Use it in result-card copy.
- `packages/shared/src/copy.ts`.

## Objective
Create the Paper file "Flocked" and build the foundations (light and dark color tokens, type scale, spacing, shape, borders, motion notes, mascot placeholder poses) and the component set every surface needs. Export the tokens file, the foundation and component PNGs, and the screen inventory, so the owner can review them for freeze OA-D1.

## Starting point
- Base: tag `wave-1`. Branch: `w2-c-design`. Worktree: `../flocked-w2-c`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w2-c -b w2-c-design wave-1
  cd ../flocked-w2-c
  ```
  You need `pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)` only to run `pnpm spec` or `pnpm check`.
- **First step:** confirm the Paper MCP tools work: load the Paper guide, then call `get_basic_info`. If the tools are missing, stop as `blocked` on OA-02 and tell the owner. Never substitute a design invented in code.

## Scope and file ownership
- May create or edit: the Paper file's `Foundations` and `Components` pages; `packages/shared/design-tokens.json`; `docs/design/screens.md` (create it, with the foundations and components sections); `docs/design/exports/foundations/**`, `docs/design/exports/components/**`; `docs/design/README.md`; `docs/sessions/W2-C.md`.
- Must not touch: any code, other Paper pages, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P2.3 in `docs/plan/wave-2.md`: the tokens JSON shape and values (colors from `Design_Language.md`, which don't change without a Z-raised decision), the Paper file and page names, artboard names `<surface>/<screen>/<state>/<breakpoint>`, 2x export paths, and the inventory table columns.

## Tasks
1. Create the worktree and confirm the Paper MCP (above).
2. `Foundations` page: color tokens in light and dark, the type scale with roles, spacing, radius, borders, motion notes, and mascot placeholder poses (neutral, smug, walking away, shocked, flock).
3. `Components` page: every component listed in wave-2.md "W2-C" under "Components", each with its states in light and dark.
4. Write `packages/shared/design-tokens.json` (P2.3) and check it parses (`node -e`).
5. Contrast: record the ink/bg, muted/bg and accentInk/accent ratios against WCAG AA in `screens.md`. Pick the dark `accentInk` and record it as a spec issue. Muted `#8A8A8A` on `#FAF7F2` (about 3.3:1) fails AA for body text, so restrict muted to large text or non-essential labels, or propose a darker muted as a spec issue.
6. Export PNGs at 2x to the P2.3 paths. Write `docs/design/screens.md` and `docs/design/README.md` (naming rules, how to export).

## Tests and checks
- The tokens JSON parses and follows P2.3's shape (W2-D adds the zod check). Every component has light and dark variants. Contrast ratios are recorded.

## Definition of done
- The owner can review Foundations and Components in Paper. Tokens, exports and inventory are committed. The handoff is written. The freeze itself is OA-D1, not this session.

## Constraints
- Design only: no application code. Don't edit `Design_Language.md` or the spec; record problems as spec issues.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, follow plan.md 2.6 (`W2-C.2`).

## End of session
1. Commit, then `git push -u origin w2-c-design`.
2. Write `docs/sessions/W2-C.md` from plan.md 3.2, with spec issues for the dark `accentInk`, muted contrast and anything else. Commit and push.
3. End with your status and: "When W2-A, B and C all report complete, start W2-D from `docs/prompts/W2-D.md`."
