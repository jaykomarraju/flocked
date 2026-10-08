# W3-C handoff: colour decisions + core round flow (part 1)

## Status
partial — colour decisions applied, plus onboarding through Sealed (15 states × 3 breakpoints). Unsealing through
Claims and the global states continue in W3-C.2 (`docs/prompts/W3-C.2.md`), the split the prompt allows.

## Summary
- Colour decisions (Oct 8): light `muted` `#6E6E6E`; new `scrim` in both schemes (`#14141466`, `#00000099`) in
  `design-tokens.json`, the `tokens.ts` schema (`HexAlpha`, `#RRGGBBAA`) and its test; dark `accentInk` pinned at
  `#121212`. Paper tokens `--color-muted`, `--color-scrim`, `--color-dark-scrim` set.
- Foundations color sheet redrawn (muted row and contrast row 4.77 / 5.10, scrim swatches and row, accentInk rule
  "Fredoka 700 ≥ 20px"); stale muted notes fixed on type, option-card, actions, stake-selector, forms-overlays and
  navigation sheets; forms-overlays scrims use the token in both modes. 11 sheets re-exported.
- Accent-text check on every sheet: all labels on accent are Fredoka 700 ≥ 20px; accent text is the 28px result
  line. One exception, recorded as spec issue 1.
- New Paper page `Core flow`, 45 artboards: onboarding cards 1–3; sign-in browser, email code, mini app; Today
  signed out, Free, Stakes, Stakes unverified, config warning, DST notice; sealing; Sealed pick known and pick lost.
  45 exports at 2x; 15 inventory rows (`review`) and the decisions in `docs/design/screens.md`.
- Decisions: the 30-day Stakes net sits in the header balance slot when Stakes is selected; the responsible-play link
  sits in the Stakes verification sheet footer (drawn in W3-C.2) and in Settings.

## Branch and head commit
`w3-c-design` @ `580964c` (this handoff and the W3-C.2 prompt follow)

## Files touched
- Edited: `packages/shared/design-tokens.json`, `packages/shared/src/tokens.ts` (scrim key only),
  `packages/shared/test/tokens.test.ts`, `docs/design/screens.md`, `docs/design/README.md`.
- Re-exported: `docs/design/exports/foundations/{color__light-dark,type__light}__desktop.png`,
  `docs/design/exports/components/{option-card__light,actions__*,stake-selector__*,forms-overlays__*,navigation__*}`.
- New: `docs/design/exports/core/*.png` (45), `docs/prompts/W3-C.2.md`, `docs/sessions/W3-C.md`.
- Paper: tokens; `Foundations` (color sheet, one note on type); `Components` (scrims, notes); new `Core flow` page.

## Tests run
| Command | Result |
| --- | --- |
| `pnpm --filter @flocked/shared exec vitest run test/tokens.test.ts` | pass (4) |
| `pnpm lint` | pass |
| `pnpm test` | pass (abi 11, settle 66, tlock 161, shared 438, api 281) |
| `pnpm format:check` | pass |
| 45 core PNGs at P2.3 paths, widths 760 / 1536 / 2240 | pass |
| `find_nodes` for `--color-muted` users and accent text; computed styles of every on-accent label | pass (see spec issue 1) |
| Dark-token check | n/a: Core flow is light only; Components dark sheets only changed scrim fill and note text |

## Traceability rows covered
None (design session; OA-D2 is the owner's freeze).

## Deviations
- Split as the prompt allows: this part covers the colour update and onboarding through Sealed. Budget: well past M
  by the end (the Paper MCP returns one line per node on every clone or duplicate).
- `tokens.test.ts`: besides the scrim key, the test now expects muted `#6E6E6E` and pins dark `accentInk` `#121212`
  (both Oct 8 decisions), and adds an opaque-scrim negative case. Nothing weakened.
- Core-flow screens are light only; dark mode follows the tokens as on the component sheets.
- Mobile artboards that scroll are `fit-content` (up to ~1090 tall); overlays and Sealed are 844.

## Spec issues
1. **Numbers on the accent** (Design_Language "Typography"): the winning option card's "38%" is Inter 600 tabular at
   32px on the accent, not Fredoka 700. It passes as large text (3.28:1). Recommend: "numerals on the accent may use
   Inter 600 tabular at ≥ 24px".
2. **`prefs.showStakesNet`** (`packages/shared/src/api/me.ts`) vs "The Stakes UI always shows the user's net result
   for the last 30 days" (Compliance). Designs show it always. Recommend the pref controls only public display
   (profile, cards).
3. **Crowd-history hint** (Client app, Today row) has no definition. Drafted "Would-you-rather days split 63/37 on
   average." Recommend: the category's average winning share over the last 30 daily rounds, hidden below 5 rounds.
4. **Copy not in Voice**, proposed on the artboards for the owner: onboarding bodies (card 2 "Each pick is locked
   with a public timelock that opens for everyone at once, a minute after the round closes. Nobody can peek. Not even
   us."; card 3 "If most people picked what you picked, you got flocked. Pick the smaller side and the bigger side's
   stakes come to you."); sealing note "Locking it until the reveal. Keep this open a second."; pick lost "Your pick is
   sealed, but this device doesn't remember it. It shows up at the reveal."; DST "Clocks go back tonight. So this round
   runs 25 hours. It still closes at 9pm ET."; config "Special rules today"; unverified "Stakes needs a verified
   account. Verify once with Coinbase to play for USDC. It takes about a minute. 18+ only."; signed out "Free to play.
   Points have no cash value."; sign-in sheet lines.
5. **Refund lines, one per reason** (`packages/shared/src/reasons.ts`), for W3-Z to bring to the owner (W3-C.2 puts
   them on the refund artboards):
   1 too few entrants: "Not enough sheep showed up. Everyone gets their stake back."
   2 one-sided: "Everyone picked the same side. No strays, no round. Stakes returned."
   3 headcount tie (approved): "A dead heat. Nobody strayed, so everyone gets their stake back."
   4 voided: "This round was called off before it closed. Everyone gets their stake back."
   5 vetoed (Stakes): "The result was challenged and thrown out. Everyone gets their stake back."
   6 timeout (Stakes): "No result was posted in time. Everyone gets their stake back."
   7 commitment not anchored (Free): "The picks weren't locked in on time, so this round doesn't count. Points returned."
   8 beacon unavailable (Free): "The timelock never opened, so the picks stay sealed. Points returned."

## Open issues
- W3-C.2: Unsealing, Counting the flock, Reveal (+ motion notes, refund lines), next question live, Stakes entry
  (verify sheet with the responsible-play link, pending, error, mismatch refusal), Claims, global states.
- OA-D1 can proceed now that muted and scrim are in (Foundations and Components re-exported). OA-D2 waits for W3-C.2.

## Notes for D and Z
- D: no code beyond the tokens schema; `scrim` is a new required key in `ColorSchemeTokensSchema` (8-digit hex).
  Nothing imports the tokens JSON yet.
- W3-C.2 clone sources on `Core flow`: mobile content frames Today Free `282-0`, signed out `2F2-0`, Stakes `2HO-0`,
  Sealed `2QT-0`; mobile header `27W-0`; nav bar `29J-0`; verify callout `2LL-0`; sign-in sheet overlay `4E8-0`;
  onboarding overlay `3PU-0`. Components: CTA `OC-0`, loading `OL-0`, pill `P0-0`, countdown reveal `107-0`, counter
  Stakes `10G-0`, split bars `113-0`/`11E-0`/`11U-0`, result cards on `15J-0`, feedback `1FR-0`, lists `1KY-0`,
  bottom sheet `1SR-0`, desktop header `20T-0`.
- Paper MCP: run `export` one call at a time (parallel calls dropped 34 of 45 files); reset `left/top` after moving
  an absolute overlay into another artboard (README "Paper MCP notes").
