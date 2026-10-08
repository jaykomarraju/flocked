# Flocked design files

The design source of truth is the Paper file **Flocked**
(`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`). This folder holds what code and tests read from it:
the screen inventory ([screens.md](screens.md)) and the 2x PNG exports. Tokens live in
[`packages/shared/design-tokens.json`](../../packages/shared/design-tokens.json). Visual rules come from
[`Design_Language.md`](../../Design_Language.md), and design sessions never edit it (plan.md 2.7).

## Pages

`Foundations`, `Components`, `Core flow`, `Social`, `Cards and notifications`, `Admin` (plan wave-2.md P2.3).
Each design session creates and edits only the pages its prompt names.

## Artboard names

`<surface>/<screen>/<state>/<breakpoint>`, lowercase kebab-case, for example `core/today/open-free/mobile`.

- `surface`: `foundations`, `components`, `core`, `social`, `cards`, `admin`.
- `breakpoint`: `mobile` (380 wide), `tablet` (768), `desktop` (1120). Foundation and component sheets are 1120
  wide and use `desktop`.
- `state`: the screen state (`open-free`, `sealed`, `revealed-win`), or `light` / `dark` for sheets. A sheet that
  shows both modes uses `light-dark`.
- Each component sheet has a light and a dark artboard.
- Inner layers use readable names (`pose/neutral`, `sheep/smug`) so code can match them.

## Tokens in Paper

The file's design tokens mirror `design-tokens.json`: `--color-*` for light, `--color-dark-*` for dark, `--font-*`,
`--text-*`, `--spacing-*`, `--radius-*`, `--breakpoint-*`. Use them as CSS variables in Paper. If a token value
changes, change it in both places, and only after a Z-raised decision for colors.

## Exporting

1. Export each artboard as PNG at **2x** (Paper MCP `export` with `{ "format": "png", "scale": "2x" }`, or Export
   in the Paper app).
2. Paper saves to `~/Downloads/<artboard name with "/" as "_">@2x.png`.
3. Move each file to `docs/design/exports/<surface>/<screen>__<state>__<breakpoint>.png`, for example
   `foundations_mascot_dark_desktop@2x.png` → `exports/foundations/mascot__dark__desktop.png`.
4. Update the row in `screens.md`. Exports are the Playwright screenshot baselines, so re-export whenever an
   artboard changes.

## Rules that came out of contrast checks

- Light `muted` (#8A8A8A) never carries body, label or caption text. It's for text ≥ 24px, placeholders, disabled
  controls and decoration.
- Text on the accent uses the `cta` role (Fredoka 700, 20px) or larger.
- Accent-colored text is ≥ 24px.
- Interactive boundaries use ink borders. `line` is only for dividers.

## Component conventions

From the `Components` page. Code follows these unless a sheet says otherwise.

- Hover: the fill changes to `line`. Border and label stay.
- Pressed: scale 0.97 (`motion.press`). Paper doesn't render transforms, so sheets draw it as a box 3% smaller.
- Selected (option card, toggle segment, preset, nav item): `ink` fill, `bg` label. The option card's radio also
  gets a check, so the pick never relies on color alone.
- Disabled: `bg` fill, 2px dashed `muted` border, `muted` label, not focusable.
- Focus: the foundation ring (2px ink outline, 3px offset), on focus-visible only.
- Errors are ink, never a color: an error icon, a 600-weight message, and (on fields) a 3px border.
- Controls get an ink border; read-only boxes (fixed stake, empty state, final-at chip) get a `line` border.
- The accent appears only on: the primary CTA, the winning option card, the winning split bar and mini split, the
  UNFLOCKED result line, the live stray-streak pill, and the smug sheep's glint.
- Scrim: ink at 40% over the page in light. Dark has no token darker than `bg`, so the sheet uses `bg` at 80% (spec
  issue in `docs/sessions/W2-C.md`).
- Percentages follow the Decision log rounding: winner rounds down, loser rounds up, "<1%" and ">99%" at the ends.
  A split-bar fill never drops below 24px.

## Paper MCP notes

- Without Paper Pro, MCP calls are capped per week. Once capped, writes, `export` and `find_nodes` fail. W2-C.2
  hit the cap after about 55 calls; the owner upgraded to Pro and the session finished.
- An 18-node `export` call wrote only 10 files and reported none; a second call with the other 8 worked. Export
  in batches of 10 or fewer and count the files in `~/Downloads`.
- `color-mix` works as `color-mix(var(--token) 40%, transparent)`. The `in srgb` form, and mixing two tokens, are
  dropped.
- `transform` is dropped. `create_artboard` ignores `left`/`top`; set them afterwards with `update_styles`.
- Dark copies: `duplicate_nodes` the light artboard, then recolor from the returned id map in one `update_styles`.
  Check with `find_nodes` for `--color-a*`, `--color-b*`, `--color-i*`, `--color-l*`, `--color-m*`, `--color-s*` on
  the dark artboard (all must be empty). SVG stroke attributes don't show up in `find_nodes`, so recolor every SVG
  path by id.
- Reuse the mascot by duplicating `sheep/*` from the Foundations page into a frame, then setting its width and
  height. In dark copies, recolor the leg path (and the shocked pose's shock lines) to `--color-dark-ink`.
