# W2-C handoff: foundations and components

## Status
blocked — the Paper MCP hit its weekly limit ("Weekly MCP limit reached. It resets in 2 days. Upgrade to Paper Pro
to continue.") after W2-C.2 finished 2 of 9 component sheets. The owner upgrades to Paper Pro or waits for the reset
(about Oct 9, 2026), then runs W2-C.3 (`docs/prompts/W2-C.3.md`).

## Summary
- W2-C: the Paper file **Flocked** (`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`) has pages
  `Foundations` and `Components` and 44 design tokens that mirror the JSON (`--color-*` light, `--color-dark-*`
  dark, type, spacing, radius, breakpoints). `Foundations` has five artboards (color, type, space-shape-motion,
  mascot light and dark), exported to `docs/design/exports/foundations/`. `packages/shared/design-tokens.json`
  follows P2.3 (13 type roles, 7 motion tokens, dark `accentInk` `#121212`).
- W2-C.2: the `Components` page has `components/option-card/{light,dark}/desktop` (idle, hover, pressed, selected,
  focus, disabled, revealed-win with a "Your pick" pill, revealed-loss, and the rounding rule) and
  `components/actions/{light,dark}/desktop` (primary CTA default/pressed/loading/disabled, secondary pill
  default/hover-pressed/disabled/small, mode toggle Free/Stakes/Stakes hidden, tabs). Each dark artboard was
  recolored from a full `find_nodes` list of its token-bound styles. The post-check found no light `--color-ink`
  on option-card dark; the limit cut off the rest of the check, which W2-C.3 runs.
- Neither W2-C.2 sheet is exported: `export` is also blocked by the limit. An empty artboard
  `components/stake-selector/light/desktop` is left for W2-C.3 to build into.
- `docs/design/screens.md` marks both sheets "draft (built)", export pending. `docs/design/README.md` gained
  "Component conventions" (hover, pressed, selected, disabled, focus) and "Paper MCP limits".

## Branch and head commit
`w2-c-design` @ `(this commit)`. W2-C's last design commit was `45557e0`.

## Files touched
- W2-C (new): `packages/shared/design-tokens.json`, `docs/design/screens.md`, `docs/design/README.md`,
  `docs/design/exports/foundations/{color__light-dark,type__light,space-shape-motion__light,mascot__light,mascot__dark}__desktop.png`,
  `docs/prompts/W2-C.2.md`, `docs/sessions/W2-C.md`.
- W2-C.2: edited `docs/design/screens.md`, `docs/design/README.md`, `docs/sessions/W2-C.md`; new
  `docs/prompts/W2-C.3.md`.
- Paper: `Foundations` (5 artboards); `Components` (4 built artboards plus 1 empty).

## Tests run
| Command | Result |
| --- | --- |
| `node -e` parse + P2.3 shape check of `design-tokens.json` (W2-C) | pass |
| `find_nodes` for light tokens on the dark artboards (W2-C.2) | partial: option-card dark has no `--color-ink` or `#141414`; the other tokens and actions dark weren't checked (MCP limit) |
| `pnpm format:check` | pass |
| `pnpm lint`, `pnpm test` (W2-C) | pass (13 shared, 66 settle); W2-C.2 changed docs only |
| `pnpm contracts:test` | not run: no contract or code changes |

## Traceability rows covered
None (design session; OA-D1 is the owner's freeze).

## Deviations
- **Blocked**, not partial: the stop is an owner action (Paper plan), not the context budget. W2-C.3 resumes.
- W2-C: foundations used W2-C's whole budget, so components moved to W2-C.2. Only the `Foundations` and
  `Components` pages exist; the other P2.3 pages are left to the sessions that own them. Foundation and component
  sheets use breakpoint `desktop` (1120) and states `light`, `dark` or `light-dark`. 13 type roles and 7 motion
  tokens go beyond the P2.3 example; the shape is unchanged.
- W2-C.2: Paper ignores CSS `transform`, so "pressed" (scale 0.97) is drawn as a box 3% smaller. The option card
  also has a keyboard focus state, beyond the wave-2.md list.
- The canvas isn't tidied yet (the actions dark artboard sits a little higher than its light one). W2-C.3 does it.

## Spec issues
1. **Dark `accentInk` is missing** (Design_Language "Color tokens", Dark). Picked `#121212` (6.04:1 on `#FF5A3A`;
   white would be 3.10:1). Recommend adding `--accent-ink: #121212` to the Dark list.
2. **Light `accentInk` on accent is 3.28:1**, which passes AA only for large text. Every label on accent is
   Fredoka 700 ≥ 20px (large bold text). Recommend writing that rule into Design_Language "Typography".
3. **Light `muted` fails AA** (3.23:1 on bg). It's restricted to text ≥ 24px, placeholders, disabled controls and
   decoration. Recommend light muted `#6E6E6E` (4.77:1 on bg). Needs an owner decision.
4. **Accent text on bg is 3.07:1** (light). Accent text must be ≥ 24px, or an accent fill with a `cta`-size label.
   Recommend stating this in Design_Language "Color tokens".
5. **Mascot ink in dark mode** (Design_Language "Mascot"). The design keeps `#141414` outlines and white wool in
   both modes and switches only strokes outside the wool to dark ink. Recommend writing that in.
6. Design_Language "Mascot" asks for React placeholder components in `packages/shared/mascot`. That's code; it
   needs an owner in a build wave (W8-C web shell or earlier). The Paper `sheep/*` layers are the source.
7. **`winLine` / `lossLine` can't express the Decision log rule** (Decision log, Oct 7, voice lines;
   `packages/shared/src/copy.ts`). They take a number, so they can't produce "<1%" or ">99%", and they leave the
   rounding (winner down, loser up) to every caller. Recommend a shared `formatShare(fraction, side)` that
   returns "38%", "<1%" or ">99%", with the two lines taking its output. Owner: the next session that owns
   `copy.ts` (W2-D or the reveal UI build).
8. **"Stakes hidden if ineligible" vs "Verify with Coinbase"** (Client app: the Today row and Entry flow
   (Stakes) step 1). Today hides the Stakes toggle for ineligible users, but the entry flow sends unverified users
   to verify, so they must see Stakes. Recommend: hide it for geo, age and self-exclusion; show it to unverified
   but otherwise eligible users and route them to verification. The sheet shows the hidden case as a static "Free"
   label.

## Open issues
- W2-C.3: seven sheets (stake-selector, round-status, result-card, feedback, lists, forms-overlays, navigation),
  then all 18 component exports, the `screens.md` rows to `review`, canvas tidy-up, and this handoff to `complete`.
- The tokens zod check is W2-D's (P2.3).

## Notes for D and Z
- D: W2-C isn't complete, so per plan.md 2.6 D waits for W2-C.3. `packages/shared/design-tokens.json` is new;
  nothing imports it yet. Prettier checks it (`docs/` is ignored).
- Z: raise spec issues 1–5 and 8 before OA-D1. Issue 3 changes a Design_Language color, so it needs an owner
  decision. Issue 7 is a small `copy.ts` change for whoever owns it.
- **Paper MCP working notes** (for every design session):
  - **Call budget.** Without Paper Pro, MCP calls are capped per week. Once capped, writes, `export` and
    `find_nodes` all fail (`get_basic_info` still worked). W2-C.2 used about 55 calls for two sheets in light and
    dark. A sheet costs about 4 to 8 writes,
    plus 4 calls for its dark copy and 1 or 2 screenshots. Leave room for 18 exports (one `export` call can take
    several nodes).
  - Dark copy in 4 calls: `duplicate_nodes` the light artboard; `find_nodes` on the copy with
    `filters: [{ styleValue: "--color-*" }]` (it lists each node's token-bound properties); one batched
    `update_styles` to the `--color-dark-*` tokens (SVG `stroke` isn't listed, so recolor SVG paths by id);
    `rename_nodes`. Check with `find_nodes` for `--color-ink` etc. on the dark artboard.
  - `write_html` returns one line per created node, so keep node counts low. One multi-line text node per table
    column, with `white-space: pre-wrap` and a fixed width.
  - `create_artboard` ignores `left`/`top`; set them afterwards with `update_styles`.
  - Paper drops `transform` (it becomes `rotate: 0deg`).
  - `get_font_family_info` fails with "Open a Paper file" even with the file open. Fredoka and Inter render.
  - `export` writes to `~/Downloads/<artboard name, "/" as "_">@2x.png`. Move each file to the P2.3 path.
