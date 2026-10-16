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

- `surface`: `foundations`, `components`, `core`, `social`, `settings`, `cards`, `notifications`, `admin`.
  `settings` artboards live on the `Social` page and export to `exports/settings/` (W5-C). `notifications`
  artboards (per-channel copy sheets and email templates) live on the `Cards and notifications` page and export to
  `exports/notifications/` (W6-C).
- `breakpoint`: `mobile` (380 wide), `tablet` (768), `desktop` (1120). Foundation and component sheets are 1120
  wide and use `desktop`. Share cards use the card variant instead (`CARD_VARIANTS` in
  `packages/shared/src/api/cards.ts`): `og` (1200×630), `embed` (1200×800), `square` (1080×1080), for example
  `cards/result/free-win/og`. The screen is the card kind (`result`, `teaser`, `round`).
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

Share cards are the exception (W6-C). Each card artboard holds the card as a frame named
`card__<kind>__<state>__<variant>` at exactly the variant size, then a `notes (not part of the card)` band with the
satori note and the 25% check. Export the **card frame**, not the artboard, so the PNG is exactly 2x the variant
(2400×1260, 2400×1600, 2160×2160): `card__result__free-win__og@2x.png` → `exports/cards/result__free-win__og.png`.

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
- Selected (option card, toggle segment, preset, nav item): `ink` fill, `bg` label. The option card's radio and the
  mode toggle's selected segment also get a check, so the pick never relies on color alone (Oct 12 decision).
- Secondary pill: `surface` fill (dark: `dark-surface`), 2px ink border, ink label. It is never transparent, so it
  reads the same on `bg` and on a surface panel (Oct 12 decision).
- Captions use the caption role: Inter 500, 13/18, `muted` (Oct 12 decision; the kit had Inter 400 ink).
- Leaderboard rows: the rank slot is 32 wide with `flexShrink: 0`, so a 3-digit rank fits (Oct 12 decision; was
  28).
- Sheets and modals that are optional close with a "Not now" text button. The 48px pill stays only where closing is
  the sheet's main action (claim all) (Oct 12 decision).
- Disabled: `bg` fill, 2px dashed `muted` border, `muted` label, not focusable.
- Focus: the foundation ring (2px ink outline, 3px offset), on focus-visible only.
- Errors are ink, never a color: an error icon and an ink message. The error box's message is Inter 500 (the label
  role, as drawn; owner, Oct 16); a field's error message is the caption size at 600, and the field gets a 3px
  border.
- Controls get an ink border; read-only boxes (fixed stake, empty state, final-at chip) get a `line` border.
- The accent appears only on: the primary CTA, the winning option card, the winning split bar and mini split, the
  UNFLOCKED result line, the live stray-streak pill (on a board, only the board's top live streak), and the smug
  sheep's glint.
- Scrim: the `scrim` token (`--color-scrim`, light `#141414` at 40%; `--color-dark-scrim`, dark `#000000` at 60%),
  flat, never a blur. In the JSON it's 8-digit hex (`#14141466`, `#00000099`).
- Percentages follow the Decision log rounding: winner rounds down, loser rounds up, "<1%" and ">99%" at the ends.
  A split-bar fill never drops below 24px.

## Kit conventions confirmed (W8-Z, Oct 16, 2026)

W8-C found these places where the drawing and the written rules differed; the owner confirmed the drawing. Paper is
the source of truth and the code matches it.

- **Error box message:** Inter 500, not 600 (see "Component conventions").
- **"Refunded":** the result card's "Refunded" title is drawn at 0 tracking (the result role is 0.02em).
- **Split-bar ceiling:** the ">99%" side's fill stops at the track width − 24, mirroring the 24px floor of the
  "<1%" side.
- **Avatar ring at 32:** 1.5px, as the lists sheet's `avatar/32` swatch and note ("1.5px below 40"), the
  navigation sheet's headers, the screen headers and the app draw it. The feedback sheet's offline-banner header is
  the one 2px outlier (fix it in the next design pass).
- **Sign-in dialog** (`core/sign-in/*`): titles Fredoka 700 22/28 (the title role is 600). The sheet is padded 12
  (with the handle) 20 32, the 400-wide modal 32 20, with 20 between the heading, the controls and the note.
- **"Not now":** none on the sign-in choose (browser), code and mini-app artboards. The email-address step ends in
  "Not now" and the Farcaster wait step in "Cancel", both text buttons.
- **Onboarding cards:** no Back button; ArrowLeft goes back a card.

## Screen conventions (Core flow)

- Mobile: mobile header, content with 16px side padding and 24px gaps, five-tab nav bar. Long screens scroll, so
  their artboards are `fit-content`; overlays and short screens are 844 tall.
- Tablet and desktop: desktop header (24px side padding on tablet, 64px on desktop) and the mobile content centred
  in a 560 column. The header links are Today, Archive, Boards and Rooms; Submit, Queue, Claims and Settings sit in
  the avatar menu (W7-C removed the "Questions" link, Oct 12 decision). The question goes up to the `display` size (40px), and the countdown and counter share a row.
- Sheets on mobile become centred 400-wide modals from tablet up (no handle, 2px ink border all round).
- The 30-day Stakes net sits in the header's balance slot when Stakes is selected.
- With the 30-day net in the slot, the tablet header only fits if the links don't shrink: header gap 32, links
  gap 20, each link `flexShrink: 0` (W3-C.2 fixed this on the Stakes tablets).
- Pages reached from You (Claims): mobile nav has You active; the desktop header shows no active link.
- Reveal artboards end in a `notes (not part of the screen)` band (motion notes, refund lines). Crop it when using
  the PNG as a baseline.
- Rows sit 1200 apart on the canvas; a row whose mobile artboard runs past ~1100 takes two slots.

## Screen conventions (Social)

- Same layout as Core flow. Build each screen from a `kit/shell/<tab>/<breakpoint>` artboard (Social page, y −1600):
  header and nav with the right tab active and an empty `content` frame. Shells aren't exported.
- Tablet and desktop header links are Today, Archive, Boards and Rooms. Submit, Queue, Claims and Settings sit in
  the avatar menu; pages reached from it show no active link, and mobile has You active.
- Rows are 2400 apart, so a long mobile screen (up to ~2300) still takes one row.

## Screen conventions (Admin)

The `Admin` page (W7-C) holds the console at `/admin`, `desktop` (1120) and `tablet` (768) only. Like the app, it
is light only. Exports are at `exports/admin/<screen>__<state>__<breakpoint>.png`.

- **Build from the kit.** `admin/kit/shell/{desktop,tablet}` hold the chrome and an empty `content` frame;
  `admin/kit/parts/desktop` holds the named parts (`part/panel`, `part/table`, `part/kpi`, `part/status/*`,
  `part/modal`, `part/refusal`, `part/field/reason`, `part/chip/*`, `part/json`, `part/toast`, `part/button/*`).
  They sit at y −1600 and aren't exported.
- **Desktop:**
  - A 232-wide rail on `bg` with a 1.5px `line` right border and padding 24. From top to bottom:
    - the wordmark and a read-only "Admin" chip;
    - the nav: Live round, Schedule, Question queue, Challenges, Holds (with an open-hold count), Users, Flags and
      config, Analytics. Items are 40 tall and pill-shaped; the selected item has an ink fill and a `bg` 600 label;
    - at the bottom, the admin's handle, "Signed in through Cloudflare Access" and "Back to the app".
  - Content is padded 32 40 48, with a 32 gap.
- **Tablet:** a 64-tall header (wordmark, chip, handle), then a tab row with the same sections. The row clips at
  the right edge with the active tab in view: for the last three tabs it is right-aligned and clips at the left.
  The active tab has a 3px ink underline and a 600 label. Content is padded 24 and two-column layouts stack.
- **Page head:** the page title in the title role (Fredoka 600 22) with a caption under it; page actions on the
  right. At most one accent CTA per screen; list and dashboard screens usually have none.
- **Panels:**
  - surface fill, 1.5px `line` border, radius 16, padding 24; the head in bodyStrong with an optional caption on
    the right;
  - a panel that needs action (interventions, a failing check, a mismatch) has a 2px ink border instead.
- **Tables:**
  - a head row in the caption role, rows 48 tall with `line` dividers, cells in the label role;
  - fixed-width column slots (`flexShrink: 0`), numbers right-aligned with tabular figures;
  - row actions are 36-tall secondary pills.
- **Status is never a colour.** A 16px ink icon plus a word:
  - check-circle for OK;
  - a triangle with a 600-weight word for attention;
  - the kit's error icon with a 600 message for failing (and its panel takes the 2px ink border);
  - a muted dashed circle with a muted word for pending or idle.
  Where the API has an enum value, the raw value sits beside the word as a caption (`pending`,
  `refund_vetoed`, `mismatch`), so an operator can match the screen to the logs.
- **Every action confirms in a modal:**
  - 480 wide, centred on the `scrim` over the screen it opens from; 2px ink border, radius 16, padding 24;
  - the title, what happens, a short consequences list, and the required **Reason** field ("Saved to the audit log
    with your name.", counter to 500);
  - a full-width CTA, then "Not now".
  - Destructive confirms use the accent CTA, as Settings' delete does.
  - An irreversible action (void) takes two steps: the second asks for the game day to be typed.
  - After the action, a toast gives the audit ID.
- **Refusals** the spec names (no void after close, no config change after question lock) use the refusal notice:
  a 2px ink border, the error icon, a 600 message, and what the admin can do instead.
- **Code-like values** (moderation JSON, hashes, `CC-RR` codes): the Admin artboards draw them in Inter, JSON at
  13/18 with `white-space: pre` in a read-only box. Since decision E8 (Oct 12) the design language has a `mono` face
  for hashes and JSON in Admin and Verify: `font.mono` in `design-tokens.json`, `--font-mono` in Paper
  (`ui-monospace, SFMono-Regular, Menlo, monospace`). No artboard uses it yet.
- **Charts** (Analytics) are monochrome: ink marks, `line` gridlines and caption-role axis labels. Two series are
  told apart by line style and a direct label, never by colour, and charts never use the accent.
- **Example data** is shared across the console: Mon, Oct 12, 2026; today's question and counts from Core flow;
  the admin @shepherd; players @woolgatherer, @ramsay, @baabara, @lambchop, @fleecebeth.

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
- Duplicating an artboard that has an absolute overlay at 100% height can reset the overlay's height to 0px, and can
  swap the order of sibling sections. Screenshot every duplicated overlay screen (W5-C).
- Several builder subagents can work on one page at once if each has its own canvas band and touches only its own
  artboards. Keep `export` in one place and run it one call at a time (W5-C exported 141 artboards in 9-node calls).
- `get_screenshot` ignores a `scale` below 1 and returns 1x. For the cards' 25% check, downscale the 1x capture
  (`sips -Z 300 card.png`) and look at that (W6-C).
- `create_artboard` and `duplicate_nodes` can drop a new artboard into any free spot on the page, including another
  builder's band. Set `left`/`top` right after each one, and check positions before finishing (W6-C.2).
- **Keep artboards whole-pixel tall.** A `fit-content` artboard whose content ends on a half pixel (1.5px borders do
  it) is, say, 995.5 tall, and its export comes out 0.25px low with a half-transparent first row (W8-C). Give new
  artboards a whole-pixel height (the W8-Z checkbox sheets are a fixed 462). Some older sheets are half-pixel tall
  (their 2x exports have an odd height: option-card, stake-selector, round-status, forms-overlays, navigation, and
  Foundations' color and type); they were left so, since their exports are screenshot baselines.
- **Inter's optical size in exports:** Paper's exports render Inter below 16px at opsz 26 (13px) and 28 (14px), not
  at the automatic optical size, so the app pins those values (W8-C). It may be a Chromium font-cache effect inside
  Paper, so a future re-export could render differently; re-run the screenshot suite after re-exporting.
- `export` takes `nodes` as a map, `{ "<nodeId>": [{ "format": "png", "scale": "2x" }] }`. If a file of the same name
  is already in `~/Downloads`, it writes `<name>@2x (1).png` (W8-Z).
