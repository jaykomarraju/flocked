# W2-C handoff: foundations and components

## Status
partial — foundations, tokens, contrast and inventory are done; the component sheets continue in W2-C.2
(`docs/prompts/W2-C.2.md`).

## Summary
- The Paper MCP works (OA-02 confirmed). The Paper file **Flocked** exists
  (`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`) with pages `Foundations` and `Components`, and
  44 design tokens that mirror the JSON (`--color-*` light, `--color-dark-*` dark, type, spacing, radius,
  breakpoints).
- The `Foundations` page has five artboards: `foundations/color/light-dark/desktop` (both palettes and a contrast
  table), `foundations/type/light/desktop` (13 roles), `foundations/space-shape-motion/light/desktop`, and
  `foundations/mascot/{light,dark}/desktop`. The placeholder poses are neutral, smug, walking away, shocked and
  flock.
- `packages/shared/design-tokens.json` follows P2.3, with Design_Language colors unchanged and dark `accentInk`
  `#121212`. It has 13 type roles and 7 motion tokens.
- `docs/design/screens.md` has the inventory (foundations rows, the planned component sheets, and the contrast
  table). `docs/design/README.md` has the naming and export rules. Five 2x PNGs are in
  `docs/design/exports/foundations/`.
- The `Components` page is empty. Its nine sheets are listed in `screens.md` as `draft`.

## Branch and head commit
`w2-c-design` @ `45557e0` (design work; this handoff commit follows)

## Files touched
- New: `packages/shared/design-tokens.json`, `docs/design/screens.md`, `docs/design/README.md`,
  `docs/design/exports/foundations/{color__light-dark,type__light,space-shape-motion__light,mascot__light,mascot__dark}__desktop.png`,
  `docs/prompts/W2-C.2.md`, `docs/sessions/W2-C.md`.
- Paper: file "Flocked", pages `Foundations` (5 artboards) and `Components` (empty).

## Tests run
| Command | Result |
| --- | --- |
| `node -e` parse + P2.3 shape check of `design-tokens.json` | pass (keys, 7 color roles × 2 modes, type and motion entry shapes) |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm test` | pass (13 shared, 66 settle) |
| `pnpm contracts:test` | not run: no contract or code changes |

## Traceability rows covered
None (design session; OA-D1 is the owner's freeze).

## Deviations
- **Partial.** Paper MCP responses are verbose (`write_html` lists every created node, and SVGs list every
  child), so foundations alone used the size-M budget. Components move to W2-C.2, per plan.md 2.6.
- Only the `Foundations` and `Components` pages were created. The P2.3 pages `Core flow`, `Social`,
  `Cards and notifications` and `Admin` are left to the design sessions that own them (the prompt forbids
  touching other pages).
- Foundation sheets use breakpoint `desktop` (1120 wide) and states `light`, `dark` or `light-dark`, because
  sheets aren't screens. README.md records this.
- Added type roles and motion tokens beyond the P2.3 example (13 roles, 7 motion tokens). The shape is unchanged.

## Spec issues
1. **Dark `accentInk` is missing** (Design_Language.md "Color tokens", Dark). Picked `#121212` (dark bg),
   6.04:1 on `#FF5A3A`. White would be 3.10:1. Recommend adding `--accent-ink: #121212` to the Dark list.
2. **Light `accentInk` on accent is 3.28:1** (#FFFFFF on #FF4F2E), which passes AA only for large text. The
   design puts every label on accent in Fredoka 700 at 20px or larger (large bold text). Recommendation: write
   that rule into Design_Language "Typography". The alternative, ink on accent (5.62:1), would change the brand
   look.
3. **Light `muted` fails AA** (#8A8A8A: 3.23:1 on bg, 3.45:1 on surface). For now it's restricted to text ≥ 24px,
   placeholders, disabled controls and decoration, and secondary text uses ink. Recommend changing light muted to
   `#6E6E6E` (4.77:1 on bg, 5.10:1 on surface) so muted can carry secondary text. Dark muted passes (6.66:1).
4. **Accent text on bg is 3.07:1** (light). UNFLOCKED at 28px passes as large text. Streak highlights must be
   ≥ 24px accent text, or an accent fill with a `cta`-size label. Recommend stating this in Design_Language
   "Color tokens" rules.
5. **Mascot ink in dark mode** (Design_Language "Mascot"). "Outlines in --ink" would make dark-mode outlines
   `#F5F2EC` on white wool. The design keeps `#141414` outlines and white wool in both modes, and switches only
   strokes outside the wool (legs, motion and shock lines) to dark ink. Recommend writing that in.
6. Design_Language "Mascot" says to build the placeholder SVGs as React components in
   `packages/shared/mascot`. That's code, so no design session can do it. It needs an owner in a build wave (W8-C
   web shell or earlier). The Paper layers `sheep/neutral`, `sheep/smug`, `sheep/walking-away` and
   `sheep/shocked` are the source.

## Open issues
- W2-C.2: the nine component sheets (light and dark), their exports, the `screens.md` rows, and this handoff
  updated to `complete`.
- The tokens zod check is W2-D's (P2.3).

## Notes for D and Z
- D: `packages/shared/design-tokens.json` is new. Nothing imports it yet, and it needs no registration. Prettier
  checks it (`docs/` is ignored).
- Z: raise spec issues 1–5 before OA-D1. Issue 3 changes a Design_Language color, so it needs an owner decision.
  If adopted, a design session updates the token, the Paper token and the color sheet.
- **Paper MCP working notes** (for every design session):
  - `write_html` returns one line per created node, so keep node counts low. Use one multi-line text node per
    table column, with `white-space: pre-wrap` and a fixed width. Without `pre-wrap`, a fixed width is ignored.
  - `<x-paper-clone>` of an SVG lists every SVG child in the response, so avoid cloning SVGs inside `write_html`.
  - For a dark variant, `duplicate_nodes` on the light artboard returns a compact id map (about 10 tokens per
    node). Then recolor with one batched `update_styles` (bg, surfaces, text color, borders, SVG `stroke`).
  - `get_font_family_info` fails with "Open a Paper file" even with the file open. Fredoka and Inter render
    correctly anyway.
  - `export` writes to `~/Downloads/<artboard name, "/" as "_">@2x.png`. Move each file to the P2.3 path.
