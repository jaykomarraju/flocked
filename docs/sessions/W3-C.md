# W3-C handoff: colour decisions + core round flow (parts 1 and 2)

## Status
complete — colour decisions applied; the whole core round flow is drawn: 37 states × 3 breakpoints (111 artboards,
111 exports, inventory rows `review`). Part 1 was W3-C, part 2 W3-C.2 (`docs/prompts/W3-C.2.md`).

## Summary
- Colour decisions (Oct 8, part 1): light `muted` `#6E6E6E`; `scrim` in both schemes (`#14141466`, `#00000099`) in
  `design-tokens.json`, the `tokens.ts` schema (`HexAlpha`) and its test; dark `accentInk` `#121212`. Paper tokens,
  the Foundations color sheet and the affected Components notes updated; 11 sheets re-exported.
- Part 1 (15 states): onboarding cards 1–3; sign-in browser, email code, mini app; Today signed out, Free, Stakes,
  Stakes unverified, config warning, DST notice; sealing; Sealed pick known and pick lost.
- Part 2 (22 states): reveal unsealing, counting, win, loss, refund, Stakes provisional ("Final at"), mode toggle,
  next question live; Stakes entry verify sheet (with "Responsible play"), pending, error, mismatch refusal; Claims
  list, Claim all, pending, empty; global loading, error, offline, empty, blocked region, self-excluded.
- Reveal artboards carry a notes band: motion notes (bars equal → shares over 3s ease-out, accent on the winner,
  card springs up, sheep walks off or flock slides in, reduced motion fades to the end state), and on refund all
  eight refund lines.
- Decisions are in `docs/design/screens.md` ("Core flow decisions (W3-C)" and "(W3-C.2)").

## Branch and head commit
`w3-c-design` @ `1ca4745` (this handoff follows)

## Files touched
- Part 1: `packages/shared/design-tokens.json`, `packages/shared/src/tokens.ts` (scrim key), `packages/shared/test/
  tokens.test.ts`; Foundations and Components re-exports; `docs/prompts/W3-C.2.md`.
- Both parts: `docs/design/screens.md`, `docs/design/README.md`, `docs/sessions/W3-C.md`.
- Exports: `docs/design/exports/core/*.png`: 45 new (part 1), 66 new (part 2), and 2 re-exported in part 2
  (`today__open-stakes__tablet`, `today__config-warning__tablet`).
- Paper: tokens; `Foundations`; `Components` (scrims, notes); `Core flow` (111 artboards, rows from y 0 to 49200).

## Tests run
| Command | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm test` | pass (abi 11, settle 66, tlock 161, shared 438, api 281) |
| `pnpm format:check` | pass |
| 111 core PNGs at P2.3 paths, widths 760 / 1536 / 2240 (`sips -g pixelWidth`) | pass |
| Part 1: tokens test, accent-text and on-accent label checks | pass (see spec issue 1) |

## Traceability rows covered
None (design session; OA-D2 is the owner's freeze).

## Deviations
- Split into two sessions as W3-C allowed. Both ran well past M: the Paper MCP returns one line per node on every
  duplicate, and part 2 needed tree checks after duplicates (README "Paper MCP notes").
- Notes bands sit inside the reveal artboards (the prompt asks for notes on the artboards), so those PNGs include
  them. Crop the band (layer `notes (not part of the screen)`) for screenshot baselines.
- Canvas: tall reveal rows take two 1200 slots (win, loss, refund, provisional, mode-toggle).
- "The next question is already live" is the closing card on every reveal artboard; the `reveal/next-live` state
  draws where it leads: Today for the next round with a "Last round" strip (`previousRoundId`).
- "Claim all" is drawn as the confirmation sheet; the list carries the button and pending the transaction.
- Part 2 fixed a part-1 bug: on the Stakes tablets the 30-day net squeezed the header links until they wrapped
  ("Toda y"). Links no longer shrink; two PNGs re-exported.
- Core-flow screens are light only; dark mode follows the tokens as on the component sheets.

## Spec issues
1. **Numbers on the accent** (Design_Language "Typography"): the winning option card's "38%" is Inter 600 tabular
   32px on the accent (3.28:1, large text). Recommend: "numerals on the accent may use Inter 600 tabular at ≥ 24px".
2. **`prefs.showStakesNet`** (`api/me.ts`) vs "The Stakes UI always shows the user's net result for the last 30
   days" (Compliance). Designs always show it. Recommend the pref controls public display only.
3. **Crowd-history hint** (Client app, Today) is undefined. Recommend: the category's average winning share over the
   last 30 daily rounds, hidden below 5 rounds.
4. **Copy not in Voice** (for the owner). Part 1: onboarding bodies, sealing note, pick lost, DST, "Special rules
   today", unverified callout, signed-out note, sign-in lines (listed on the artboards). Part 2: unsealing "Entries
   closed at 9pm. The timelock opens for everyone at once."; counting "The timelock is open. Every pick is being
   tallied."; "Last round" / "See the reveal"; "You didn't play Stakes this round." / "Back to your Free result";
   verify sheet "I'm 18 or older", "I accept the Stakes terms", "18+ only", "Responsible play"; pending "Confirming",
   "Waiting for Base to include your entry. Usually a few seconds."; mismatch "This round doesn't match its onchain
   record", "The published stake is 10 USDC. Onchain it's 50 USDC. We won't build your entry while they differ.",
   "See what doesn't match"; Claims "Stakes payouts and refunds you haven't claimed yet.", "Ready to claim", "2 of 3
   are ready. The third opens at 11:03pm.", "Payouts go to the wallet that entered, 0x3f2c…a91c. Claims from rounds
   you already entered stay open, wherever you are.", "Claim 17.67 USDC", "Two payouts, one transaction. They go to
   0x3f2c…a91c.", "The Oct 8 payout opens at 11:03pm. Claim it then.", "Claiming", "Waiting for Base to confirm.
   Usually a few seconds.", "Nothing to claim. The flock owes you nothing.", "Back to Today"; self-excluded "You're on
   a break until Nov 7.", "No picks in either mode until then, and no game notifications.", "Claims and refunds still
   work".
5. **Refund lines, one per reason** (`reasons.ts`), on the refund artboards for W3-Z to bring to the owner; only 3
   is a Voice line. 1 "Not enough sheep showed up. Everyone gets their stake back." 2 "Everyone picked the same side.
   No strays, no round. Stakes returned." 3 "A dead heat. Nobody strayed, so everyone gets their stake back." 4 "This
   round was called off before it closed. Everyone gets their stake back." 5 "The result was challenged and thrown
   out. Everyone gets their stake back." 6 "No result was posted in time. Everyone gets their stake back." 7 "The
   picks weren't locked in on time, so this round doesn't count. Points returned." 8 "The timelock never opened, so
   the picks stay sealed. Points returned." Note for line 2: in Free, "Stakes returned" can read as the mode name;
   recommend "Everyone gets their stake back." there too.
6. **Unsealing format** (Reveal choreography "Unsealing in 1:42" vs the round-status sheet's hh:mm:ss rule): drawn
   as m:ss per the spec, since it never exceeds 10:00. Recommend recording that exception on the sheet.
7. **Where the 18+ attestation and ToS acceptance happen** (Compliance "Age and terms" vs Entry flow (Stakes) step 1,
   "already checked via `/me`"): drawn as checkboxes in the verification sheet. Recommend the spec name the sheet as
   the place they're collected, stored with timestamp and ToS version.
8. **Desktop header** (Client app "Navigation": Submit, Queue, Claims, Settings "sit in the header" on desktop): at
   768 the header can't fit them next to the five links and the 30-day net. Drawn as the navigation sheet says, one
   tap from the avatar, with no active link on Claims. Recommend the spec say "header avatar menu".
9. **Navigation sheet note** says the balance is hidden in Stakes; superseded by the 30-day-net decision. The note on
   the Components page (OA-D1) needs updating; not changed here (outside this prompt's pages).

## Open issues
- OA-D2: owner review of all 37 core-flow states (W3-Z brings the copy in spec issues 4–5).
- Share card content (provisional and refund cards) is only previewed here; the share-card design belongs to the
  `Cards and notifications` page session.
- Dark-mode core screens aren't drawn (tokens map them).

## Notes for D and Z
- D: no code beyond part 1's tokens schema (`scrim`, required, 8-digit hex). Nothing imports the tokens JSON yet.
- Exports are screenshot baselines; reveal PNGs include the notes band (crop it).
- Copy for code: Voice lines exactly as `VOICE` in `packages/shared/src/copy.ts`; refund lines need owner sign-off
  before they become a copy table keyed by `RefundReasonName`.
- Paper MCP: export one call at a time (≤ 10 nodes); verify `duplicate_nodes` copies with `get_tree_summary`
  before editing by id; a copy into an artboard can land above the header (README "Paper MCP notes").
