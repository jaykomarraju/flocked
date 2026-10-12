# W6-C handoff: share cards and notifications (W6-C and W6-C.2)

## Status
complete — cards, share sheet, `/s/:shareId`, notification copy for every event and channel, email templates and
`copy/notifications.ts` are done; both parts ran in one session at the owner's request.

## Summary
- New Paper page `Cards and notifications` (`p-5-0`), 92 artboards, all exported at 2x and inventoried (`review`):
  - **Cards (63):** 21 states × `og`, `embed`, `square`. Results: Free win, Free win + streak, Free loss, Stakes win
    (multiple, the default; or the amount), Stakes loss. Refunds: one per rule and mode (Free 1, 2, 3, 4, 7, 8;
    Stakes 1–6). Teaser (sealed). Round (Free, Stakes). Each artboard is the card frame at the exact variant size plus
    a notes band (satori primitives, 25% check); the export is the card frame.
  - **Share (16):** share sheet for a result (web; mini app) and the teaser, and `/s/:shareId` for a result and the
    teaser before and after the reveal, at `mobile`, `tablet`, `desktop`, with the head tags in notes bands.
  - **Notifications (13):** Farcaster and web push sheets listing every event and variant, the refund-lines table
    (rules 1–8; 4, 7 and 8 marked), and five email templates at `mobile` and `desktop`.
- `packages/shared/src/copy/notifications.ts`: the final copy as data (`NOTIFICATION_COPY[event][channel][variant]`,
  `null` = not sent), `NOTIFICATION_EVENT_CHANNELS`, `REFUND_LINES` (1–8), `OUTCOME_NEXT_LIVE`, `EMAIL_CHROME`,
  `PUSH_LIMITS`, `fillCopy`, `isGameNotification`. Test: `packages/shared/test/copy-notifications.test.ts` (9 tests).
- `screens.md`: "Cards and notifications" section (inventory, card decisions, share and notification decisions).
  `README.md`: `notifications` surface, card variants as breakpoints, the card-frame export rule, two Paper MCP notes.
- Built by five builder subagents in separate canvas bands from briefs I wrote, after I reviewed the templates. I
  spot-checked the templates, a refund card, the teaser, an email and a share sheet, and ran every export myself.

## Branch and head commit
`w6-c-design` @ the commit that adds this handoff (cards `db8a3dd`, copy `f100d86`).

## Files touched
- New: `packages/shared/src/copy/notifications.ts`, `packages/shared/test/copy-notifications.test.ts`,
  `docs/design/exports/cards/*.png` (79), `docs/design/exports/notifications/*.png` (13), `docs/prompts/W6-C.2.md`,
  `docs/sessions/W6-C.md`.
- Edited: `docs/design/screens.md`, `docs/design/README.md`. Paper: page `Cards and notifications` (new) only.

## Tests run
| Command | Result |
| --- | --- |
| `pnpm lint` / `typecheck` / `test` / `format:check` | pass (Node 22) |
| `vitest run test/copy-notifications.test.ts` | pass (9 tests) |
| exports | 92 of 92 at their `screens.md` paths; cards exactly 2x the variant, screens 760 / 1536 / 2240 wide |

## Traceability rows covered
None closed (design). Inputs for AC-7 and E2E-3 (W10-A, W11-D).

## Deviations
- Ran as W6-C plus W6-C.2 in one session (owner's request); `docs/prompts/W6-C.2.md` was emitted first, as plan.md
  2.6 asks, and is now done. It sits outside the prompt's file list.
- Card exports are the card frames, not the artboards (README "Exporting"). The 25% check downscales a 1x screenshot
  with `sips`, because `get_screenshot` ignores a scale below 1.
- No dark artboards: cards, share pages and emails are light only, so the dark-token check has nothing to check.

## Spec issues
1. **Accent on cards** (Design_Language "Share cards" lists only the winning bar and UNFLOCKED). The streak pill (a
   "streak highlight") and the smug sheep's glint also use it. Recommend a Decision log row allowing both on cards.
2. **Domain** ("Share cards and distribution": wordmark and URL). None in the spec; cards and emails show
   "flocked.app". Recommend the owner pick it before W10-A.
3. **Long questions and amounts.** `og`/`embed` fit about 75 question characters on 2 lines (prompts go to 120);
   "+16.00 USDC" just fits at 76px. Recommend W10-A step the question and result line down 4px at a time until they
   fit (floors 32px and 56px).
4. **`outcome` has no `refundReason` or share** (`packages/shared/src/queues.ts`). The copy needs both: a refund at
   the reveal says why, and win/loss lines quote the player's side ("You and 38% of people…"). Recommend adding
   `refundReason: RefundReasonCodeSchema.nullable()` to the payload (W6-D/Z); the consumer reads the share from the
   tally (`formatShare`), or the payload gains `share`.
5. **Free refund wording.** Lines 1–4 say "stake back", 7–8 "Points returned"; Free stakes are points, so both hold.
   Recommend keeping them.

## Open issues
- **New copy for W6-Z to bring to the owner** (all in `copy/notifications.ts` unless noted):
  - Push titles: "Today's question is live", "An hour left", "Unflocked {amount}", "You got flocked", "{mode} round
    refunded", "Your pick didn't count", "Ready to claim", "Free/Stakes round refunded", "Your question made the
    cut", "Your question settled", "{streak}-day stray streak", "Your question was edited", "New sign-in with
    email", "New sign-in method", "Account merge pending", "Accounts merged".
  - Push bodies: "Today's question closes in an hour. The flock is forming without you."; the Voice win/loss lines
    without their first sentence ("You and {share} of people out-thought everyone.", "{share} thought the same thing
    you did."); "It was left out of the count and your stake is back."; "{payout} is ready to claim. It goes to the
    wallet that entered."; "Your refund is waiting in Claims."; "It's on the schedule. We'll tell you how the flock
    splits."; "See how the flock split on it."; "Today's question closes in 3 hours. Sit it out and the streak
    ends."; "We changed its wording. See the new version."; the four security bodies; "The next question is live."
  - Email: headings, CTAs ("See the reveal", "See the round", "Claim {payout}", "Go to Claims", "Open Settings",
    "Review it in Settings"), "Play the next question", the footers.
  - Cards and share (screens.md): "38% strayed. They won."; "3-day stray streak"; "Free · Oct 12" labels; "Share
    your result", "Share the question", "The card shows the question, not your pick.", "Casts show the card with a
    Play button.", "Wide"/"Square", "Cast", "Copy link", "Download image"; share texts "Unflocked. 3-day stray
    streak.", "Got flocked." / "Got flocked again."; "Play today's Flocked" (spec), "See the round", "See the
    reveal", "@woolgatherer sealed a pick.", "The round has revealed.", "Flocked is a daily question. Pick the side
    fewer people pick."
- **Open questions** (my recommendation first): (a) "Got flocked again." — use it after a loss the previous game day
  (recommend), or drop it. (b) Show the outcome email's share card image — not now; add it with W10-A's renders if
  wanted. (c) Merge notices assume the merge completes on its own; check against the merge flow when it's built.
- For W10-A (satori): each card's notes band names its primitives. Inline each sheep pose and the flock as one SVG
  (they contain inner `transform`s). Fonts as TTF (Fredoka 600/700, Inter 500/600/700). The square flock is small.
- Kit carry-over (W7-C): the Core flow claim-all sheets still use the old "Not now" pill; the share sheets use the
  Oct 12 text button. The share previews cloned from the reveal screen show "@jay" (that screen's user).

## Notes for D and Z
- **Export for D:** add `export * from './copy/notifications';` to `packages/shared/src/index.ts`. It exports
  `SecurityNoticeKind`; no name clashes with the current index (check after W6-A/B merge).
- Consumers: W11-D (notify consumer) fills templates with `fillCopy`, appends `OUTCOME_NEXT_LIVE` when `nextRoundId`
  is set, skips game events for self-excluded users (`isGameNotification`), and uses `null` as "not sent".
- OA-D4 (owner): review the `Cards and notifications` page in Paper and freeze it.
