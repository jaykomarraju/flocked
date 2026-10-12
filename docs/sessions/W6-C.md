# W6-C handoff: share cards and notifications (part 1: cards)

## Status
partial — every share card is drawn, exported and inventoried; the share sheet, `/s/:shareId`, the notification
copy, `copy/notifications.ts` and the email templates continue in W6-C.2 (`docs/prompts/W6-C.2.md`), as the prompt's
planned split.

## Summary
- New Paper page `Cards and notifications` (page id `p-5-0`) with 63 card artboards: 21 states × `og`, `embed`,
  `square`. Results: Free win, Free win with the stray streak, Free loss, Stakes win with the multiple (default) or
  the amount, Stakes loss. Refunds: one card per rule and mode (Free 1, 2, 3, 4, 7, 8; Stakes 1–6). Teaser (sealed).
  Round card (Free, Stakes).
- Each artboard is the card frame `card__<kind>__<state>__<variant>` at the exact variant size plus a notes band
  with the satori primitives and the 25% check. The exports are the card frames at 2x (2400×1260, 2400×1600,
  2160×2160), all 63 at their P2.3 paths, and each size was checked with `sips`.
- `screens.md`: new "Cards and notifications" section with inventory rows (all `review`) and "Cards decisions
  (W6-C)". `README.md`: the `notifications` surface, card variants as breakpoints, the card-frame export rule, and a
  Paper MCP note (`get_screenshot` ignores scale < 1).
- Built by two builder subagents working in parallel, each on its own canvas band, from three templates (Free win)
  that I reviewed first. Both were cut off once by an API rate limit and resumed with their context. I spot-checked
  the templates, the rule 7 refund card and the teaser.

## Branch and head commit
`w6-c-design` @ `db8a3dd` (cards), plus the commit that adds this handoff.

## Files touched
- New: `docs/design/exports/cards/*.png` (63), `docs/prompts/W6-C.2.md`, `docs/sessions/W6-C.md`.
- Edited: `docs/design/screens.md` (new cards section), `docs/design/README.md` (card naming and export
  conventions, `notifications` surface, one Paper MCP note).
- Paper: page `Cards and notifications` (new). No other page touched.

## Tests run
| Command | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass (no code changed) |
| `pnpm format:check` | pass |
| exports | 63 of 63 present at their `screens.md` paths, each exactly 2x its variant |

## Traceability rows covered
None closed. The cards are the design input for AC-7 and E2E-3 (W10-A, W11-D).

## Deviations
- Split as the prompt allows (`W6-C.2`). This part delivers the prompt's first half; nothing in it is skipped.
- The exports are the card frames, not the artboards, so the PNGs are exactly the variant size; the notes bands stay
  on the artboards (README "Exporting").
- `docs/prompts/W6-C.2.md` sits outside the prompt's file list, but plan.md 2.2 and 2.6 require continuation prompts
  to be saved there (as W2-C.2 and W3-C.2 were).
- The 25% check downscales a 1x screenshot with `sips`, because `get_screenshot` ignores a scale below 1.

## Spec issues
1. **Accent on cards** (Design_Language "Share cards" vs "Color tokens"). "Share cards" allows the accent only on the
   winning bar and UNFLOCKED, but the streak pill (a "streak highlight") and the smug sheep's glint (README component
   conventions) also use it. The cards follow the wider rule. Recommend a Decision log row allowing the stray-streak
   pill and the glint on cards.
2. **Domain** ("Share cards and distribution": "Wordmark and URL"). The spec names no domain, so the cards use
   "flocked.app" as a placeholder. Recommend the owner pick it before W10-A.
3. **Long questions and amounts** ("Share cards and distribution" + question rules: prompt 1–120 characters).
   `og` and `embed` fit 2 question lines at 42/48px, about 75 characters. "+16.00 USDC" just fits one line at
   76px, and larger amounts won't. Recommend a renderer rule for W10-A: step the question (and the result line)
   down 4px at a time until it fits 2 lines (3 in `square`), with a floor of 32px for the question and 56px for the
   result line.
4. **Free refund wording** (Design_Language refund table). Lines 1–4 say "stake back" and 7–8 say "Points returned".
   Free stakes are points, so both are accurate. Recommend keeping them as written.
5. **`outcome` carries no `refundReason`** (`packages/shared/src/queues.ts`, spec "Notifications"). The prompt says
   `outcome` and `refunded` carry it, but only `refunded` does. Without it, an outcome for a mode refunded at the
   reveal (rules 1–3, 7, 8) can't say why. Recommend adding `refundReason: RefundReasonCodeSchema.nullable()` to
   the `outcome` payload (W6-D or W6-Z), before W6-C.2 writes that copy.

## Open issues
- New copy on the cards, for W6-Z to bring to the owner: "38% strayed. They won." (round card); "3-day stray streak"
  (pill; the spec's share text writes "3 day stray streak"); "Free · Oct 12" / "Stakes · Oct 12" labels, with
  " · Room" and " · 1,204 players". Reused as written: "Your pick", "Sealed", "Refunded" (result-card component),
  "UNFLOCKED +86 pts" / "+16.00 USDC" / "2.6x" and "GOT FLOCKED" (spec), "I sealed my pick. Can you out-think the
  flock?" (spec share text), and the eight refund lines (Design_Language).
- For W10-A (satori): each card's notes band names its primitives. Inline each sheep pose, and the five-sheep flock,
  as one SVG; the pose SVGs contain inner `transform` attributes, so check they render. Load the fonts as TTF
  (Fredoka 600/700, Inter 500/600/700). The square's flock is small (400×120); if it fails at 25% in a feed, scale it
  up in W10-A or in a design fix.
- The share sheet, `/s/:shareId`, notification artboards, email templates and `copy/notifications.ts`: W6-C.2.

## Notes for D and Z
- Nothing to register from this part. W6-C.2 adds `packages/shared/src/copy/notifications.ts` and will list its
  `index.ts` export here.
- For W6-C.2, groundwork from this session:
  - Channels by the spec table: `question_live`, `closing_soon`, `question_used`, `streak_at_risk` and
    `question_edited` go to Farcaster and web push only; `payout_claimable` to web push and email;
    `outcome`, `refunded` and `security_notice` to all three.
  - `security_notice` is the only non-game event, so self-excluded users still get it.
  - Farcaster mini app notifications cap the title at 32 characters and the body at 128 (check the current
    Farcaster docs). Fill templates with worst-case values in the test: a 120-character question, ">99%", and the
    84-character rule 2 line plus "The next question is live.".
  - The `outcome` payload has no share percentage, so copy that uses the Voice win and loss lines needs the
    consumer to read the tally, or a new payload field.
- The OA-D4 freeze (cards) waits on W6-C.2 and the owner's review in Paper.
