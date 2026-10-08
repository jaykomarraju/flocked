# W2-C handoff: foundations and components

## Status
complete — Foundations and all nine component sheets (light and dark) are built, exported and in `screens.md` as
`review`, ready for the owner's freeze (OA-D1).

## Summary
- W2-C: the Paper file **Flocked** (`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`) has pages
  `Foundations` and `Components` and 44 design tokens that mirror the JSON. `Foundations` has five artboards
  (color, type, space-shape-motion, mascot light and dark). `packages/shared/design-tokens.json` follows P2.3
  (13 type roles, 7 motion tokens, dark `accentInk` `#121212`).
- W2-C.2: the `Components` page has 18 artboards, `components/<sheet>/{light,dark}/desktop` for option-card,
  actions, stake-selector, round-status, result-card, feedback, lists, forms-overlays and navigation. One row per
  sheet on the canvas, light at x 0 and dark at x 1200. States per sheet are in `docs/design/screens.md`.
- The session stopped once on the Paper MCP weekly limit (after 2 sheets, handoff `blocked` at `eb15580`). The owner
  upgraded to Paper Pro and the same session finished the remaining 7 sheets, so the W2-C.3 prompt was deleted.
- 18 exports at 2x (2240 wide) are in `docs/design/exports/components/`. `docs/design/README.md` has the component
  conventions (states, errors, borders, where the accent may appear, scrim, rounding) and Paper MCP notes.

## Branch and head commit
`w2-c-design` @ `4abf4ef` (this head-commit fix follows). W2-C's last design commit was `45557e0`.

## Files touched
- W2-C (new): `packages/shared/design-tokens.json`, `docs/design/{screens,README}.md`,
  `docs/design/exports/foundations/*.png` (5), `docs/prompts/W2-C.2.md`, `docs/sessions/W2-C.md`.
- W2-C.2: new `docs/design/exports/components/*.png` (18); edited `docs/design/screens.md` (Components section),
  `docs/design/README.md`, `docs/sessions/W2-C.md`; `docs/prompts/W2-C.3.md` added at the block, then deleted.
- Paper: `Components` page, 18 artboards. `Foundations` untouched.

## Tests run
| Command | Result |
| --- | --- |
| `node -e` parse + P2.3 shape check of `design-tokens.json` (W2-C) | pass |
| `find_nodes` on each of the 9 dark artboards for `--color-a*`, `-b*`, `-i*`, `-l*`, `-m*`, `-s*` (positive control on a light node matched) | pass: 0 light-token uses |
| Visual check of every light and dark artboard (screenshots), contrast rules from `screens.md` | pass |
| 18 PNGs present at the P2.3 paths, 2240 px wide | pass |
| `pnpm format:check` | pass |
| `pnpm lint`, `pnpm test` (W2-C) | pass (13 shared, 66 settle); W2-C.2 changed docs only |
| `pnpm contracts:test` | not run: no contract or code changes |

## Traceability rows covered
None (design session; OA-D1 is the owner's freeze).

## Deviations
- W2-C: components moved to W2-C.2 (budget). Only `Foundations` and `Components` exist; the other P2.3 pages
  belong to later sessions. Sheets use breakpoint `desktop` and states `light`, `dark` or `light-dark`.
- Paper drops `transform`, so "pressed" (scale 0.97) is drawn as a box 3% smaller.
- States beyond the wave-2.md list: option-card focus; CTA loading; low balance and over-cap stakes; reveal countdown;
  tie and extreme split bars; error with a known cause; mobile header. They came from the spec flows.
- Mascot SVGs keep literal art colors (`#141414` outlines, `#FFFFFF` wool), as on Foundations. In dark copies the
  legs and shock lines use `--color-dark-ink`. The dark-only check covers tokens, not mascot art.
- Copy not in Design_Language "Voice" is proposed on the sheets (see spec issue 10).

## Spec issues
1. **Dark `accentInk` is missing** (Design_Language "Color tokens", Dark). Picked `#121212` (6.04:1 on `#FF5A3A`).
   Recommend adding `--accent-ink: #121212`.
2. **Light `accentInk` on accent is 3.28:1** (large text only). Every label on accent is Fredoka 700 ≥ 20px.
   Recommend writing that rule into Design_Language "Typography".
3. **Light `muted` fails AA** (3.23:1 on bg). Restricted to text ≥ 24px, placeholders, disabled controls and
   decoration. Recommend `#6E6E6E` (4.77:1). Needs an owner decision.
4. **Accent text on bg is 3.07:1** (light). Accent text ≥ 24px, or an accent fill with a `cta`-size label (the
   streak pill does this). Recommend stating it in "Color tokens".
5. **Mascot ink in dark mode** (Design_Language "Mascot"): outlines stay `#141414`, wool white; only strokes outside
   the wool go dark ink. Recommend writing that in.
6. Design_Language "Mascot" asks for React placeholders in `packages/shared/mascot`. Needs a build-wave owner (W8-C
   or earlier); the Paper `sheep/*` layers are the source.
7. **`winLine` / `lossLine` can't express the Decision log rule** (`packages/shared/src/copy.ts`). They take a
   number, so no "<1%" / ">99%", and every caller must round (winner down, loser up). Recommend a shared
   `formatShare(fraction, side)` whose output the lines take. Owner: next session that owns `copy.ts`.
8. **"Stakes hidden if ineligible" vs "Verify with Coinbase"** (Client app: Today row; Entry flow (Stakes) step 1).
   Unverified users must see Stakes to be sent to verification. Recommend hiding it only for geo, age and
   self-exclusion. The sheets show both: a static "Free" label, and a verification bottom sheet.
9. **No scrim token** (Design_Language "Color tokens"). Light uses ink at 40%; dark has nothing darker than `bg`,
   so the sheet uses `bg` at 80%, which doesn't dim much. Recommend a `scrim` token (light `#141414` at 40%, dark
   `#000000` at 60%). Needs a Z-raised decision (color).
10. **Voice lines missing** (Design_Language "Voice"). Proposed on the sheets: refunded ("A dead heat. Nobody
    strayed, so everyone gets their stake back.", tie only), offline ("You're offline. Nothing can be sealed until
    you're back."), entry 4xx ("This round just closed. Your pick wasn't sent."), over the daily cap ("You've hit
    today's cap. The flock will still be here tomorrow."). Refunds need one line per reason (rules 1–8). Recommend
    the owner approves them and they go into `copy.ts`.
11. **Navigation isn't specified** (Client app). The sheets propose five tabs, Today, Archive, Boards, Rooms and
    You, with Submit, Queue, Claims and Settings under You (mobile) or the header (desktop, plus Questions).
    Recommend the owner confirms before the shell is built.

## Open issues
- The tokens zod check is W2-D's (P2.3).
- Spec issues 3 and 9 change colors; if adopted, a design session updates the tokens, the Paper tokens and the
  affected sheets, then re-exports.

## Notes for D and Z
- D: W2-C is complete. `packages/shared/design-tokens.json` is new; nothing imports it yet. Prettier checks it
  (`docs/` is ignored). The 23 PNGs under `docs/design/exports/` are binary; nothing reads them yet.
- Z: raise spec issues 1–5 and 8–11 before OA-D1. Issues 3 and 9 need owner color decisions; 7 and 10 are small
  `copy.ts` changes for whoever owns it.
- Paper MCP notes for later design sessions are in `docs/design/README.md` ("Paper MCP notes"): the call cap
  without Pro, exports in batches of 10 or fewer, `color-mix` syntax, the 4-call dark copy and its check, and
  reusing the sheep. Also: `write_html` returns one line per created node, so keep node counts low;
  `get_font_family_info` fails with "Open a Paper file" (Fredoka and Inter render anyway); `export` writes to
  `~/Downloads/<artboard name, "/" as "_">@2x.png`.
