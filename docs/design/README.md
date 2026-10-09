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

- Light `muted` is `#6E6E6E` (Oct 8 decision, 4.77:1 on bg), so it may carry secondary text at any role. Primary
  information stays ink.
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
- Scrim: the `scrim` token (`--color-scrim`, light `#141414` at 40%; `--color-dark-scrim`, dark `#000000` at 60%),
  flat, never a blur. In the JSON it's 8-digit hex (`#14141466`, `#00000099`).
- Percentages follow the Decision log rounding: winner rounds down, loser rounds up, "<1%" and ">99%" at the ends.
  A split-bar fill never drops below 24px.

## Screen conventions (Core flow)

- Mobile: mobile header, content with 16px side padding and 24px gaps, five-tab nav bar. Long screens scroll, so
  their artboards are `fit-content`; overlays and short screens are 844 tall.
- Tablet and desktop: desktop header (24px side padding on tablet, 64px on desktop) and the mobile content centred
  in a 560 column. The question goes up to the `display` size (40px), and the countdown and counter share a row.
- Sheets on mobile become centred 400-wide modals from tablet up (no handle, 2px ink border all round).
- The 30-day Stakes net sits in the header's balance slot when Stakes is selected.
- With the 30-day net in the slot, the tablet header only fits if the links don't shrink: header gap 32, links
  gap 20, each link `flexShrink: 0` (W3-C.2 fixed this on the Stakes tablets).
- Pages reached from You (Claims): mobile nav has You active; the desktop header shows no active link.
- Reveal artboards end in a `notes (not part of the screen)` band (motion notes, refund lines). Crop it when using
  the PNG as a baseline.
- Rows sit 1200 apart on the canvas; a row whose mobile artboard runs past ~1100 takes two slots.

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
- Don't run `export` calls in parallel: five parallel calls wrote 11 of 45 files and reported none. Run one call at a
  time (8–10 nodes each) and check the files.
- A node moved with `move_nodes` into another artboard keeps its world position, so an absolutely positioned
  overlay ends up offset. Set `left: 0; top: 0` after moving it.
- Build tablet and desktop by duplicating a header-only shell artboard and then `duplicate_nodes` the mobile
  `content` into it (`parentId`). That returns a compact id map; an `<x-paper-clone>` returns every created node.
- `duplicate_nodes` id maps can be wrong. In W3-C.2, copies of artboards whose children had been reordered with
  `move_nodes` came back with ids pointing at the wrong nodes (a bar track got the sheep's size). Check the copy with
  `get_tree_summary` before editing by id.
- A `duplicate_nodes` into an artboard with `parentId` sometimes lands at index 0, above the header, and reordered
  children can come back in their original order. Screenshot each copy and fix the order with `move_nodes`.
