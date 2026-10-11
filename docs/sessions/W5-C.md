# W5-C handoff: profiles, boards, rooms, settings, verify

## Status

complete — every listed state is drawn at mobile, tablet and desktop, exported at 2x, and listed as `review`.

## Summary

- **Components fixes (Oct 9 decisions).**
  - The navigation sheet's header note now says the balance slot shows the 30-day net in Stakes.
  - The round-status sheet notes the m:ss unsealing exception.
  - Both sheets were re-exported (light and dark) and their rows updated.
- **New Paper page `Social`:** 47 states × 3 breakpoints = 141 artboards. Surfaces:
  - `social`: Round detail (settled, voided), Archive, Verify (overview, entry passed, failed, no receipt), Profile (own, other), Boards (four tabs, empty), the You menu, Submit (form, queued, rejected, review, blocked), Queue (list, empty), Rooms (list, empty, create, invite, join, round, revealed, board).
  - `settings`: overview, merge pending, verification (unverified, failed), payout wallet, notifications, stake cap (edit, pending), self-exclusion (choose, confirm, active, permanent, lift request, lift pending), delete (unclaimed, blocked, confirm).
- **Build scaffolding:** 12 `kit/shell/*` artboards (header and nav per active tab, y −1600). They aren't exported.
- **Docs.**
  - `screens.md` gains the Social and Settings inventories and the W5-C decisions.
  - `README.md` gains the `settings` surface, the Social screen conventions and two Paper MCP notes.

## Branch and head commit

`w5-c-design` @ `fdec1c0`, plus the commit that adds this handoff. Base: tag `wave-4`.

## Files touched

- `docs/design/exports/components/{navigation,round-status}__{light,dark}__desktop.png` (re-exported).
- `docs/design/exports/social/*.png` (90 new) and `docs/design/exports/settings/*.png` (51 new).
- `docs/design/screens.md`, `docs/design/README.md` (edited); `docs/sessions/W5-C.md` (new).
- Paper: page `Social` (new); on `Components`, only the two notes above.

## Tests run

| Command | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm test` | pass: abi 13, settle 66, tlock 176, shared 439, api 546 |
| `pnpm format:check` | pass |
| Exports | 141 + 4 PNGs at their P2.3 paths; widths 760 / 1536 / 2240 (2x), checked with `sips` |
| Dark check (`find_nodes`) | `--color-{a,b,i,l,m,s}*` all empty on both re-exported dark sheets; a `--color-dark-a*` control matches. Social screens are light only, as on Core flow |

## Traceability rows covered

None. This is a design session, and the OA-D3 freeze is the owner's.

## Deviations

- **Size.** Far over M. I built the page with six parallel builder subagents (one canvas band each, from a shared brief), which used about 1.8M tokens in total; my own context was about 230k. No W5-C.2 was needed.
- **Header links.** Social headers have no "Questions" link, per Client app "Navigation" (Oct 9). Core flow headers still show it (spec issue 1).
- **Stand-ins for missing components.**
  - Checkboxes replace switches, because the kit has no switch component.
  - A 3-segment control (from the mode toggle) is used for notification channels and room boards.
- **Copy.** All screen copy is drafted (lines below). The Voice lines are used verbatim: win line, refund rules 1 and 4, self-exclusion, empty state.

## Spec issues

1. **"Questions" header link** (Client app "Navigation", Oct 9 Decision log row).
   - The Core flow tablet and desktop headers, and the navigation sheet ("Same five destinations plus Questions"; "Submit and Queue open … from the header on desktop"), still show it.
   - Recommend: a design session removes it from Core flow (74 artboards) and the sheet, then re-exports.
2. **Strays today vs Streaks** ("Leaderboards"). A live stray streak implies a win on the latest settled game day (refunds are neutral), so the two lists nearly coincide.
   - Recommend: Streaks ranks the best stray streak (all time), with the current streak as the caption.
   - Accent pill: drawn on the board's top live streak only, because putting it on every live row would spread the accent across the whole board. Recommend the lists sheet say "top live streak".
3. **Round detail when both modes were played** ("Client app" table). Recommend a result box under each mode played (drawn for Free only).
4. **Archive row mode** ("Archive"). Recommend the row shows the mode you played: Free if both or neither, Stakes if only Stakes.
5. **Verify my entry on another device** ("Client app" Verify). Free receipts are local, so drawn as "No receipt on this device", with totals still checkable; Stakes checks `Entered` from any device. Recommend the spec say so.
6. **Destructive confirm** (delete account). It uses the accent primary CTA, as the one primary action. Recommend the owner confirm, or pick an ink-filled destructive button (it would be a new component).
7. **Security notices** ("Notifications", not read here). Drawn as a normal checkbox. Recommend Z confirm whether `security_notice` can be turned off.
8. **Mobile You sheet** ("Navigation"). It stops above the nav bar, so the You tab stays visible and toggles it. Recommend the spec say "the You tab toggles the You sheet".
9. **Kit inconsistencies** (Components, OA-D1; for Z to settle and a design session to apply):
   - secondary pill fill: the kit uses surface, but "transparent" is assumed in places;
   - captions: the kit uses Inter 400 ink, the type table Inter 500 muted;
   - selected segments: the mode toggle has no check, against the "fill + check" rule;
   - the 28px rank slot overflows at 3 digits (recommend 32);
   - sheet dismissal: a "Not now" text button (Social) vs a 48px pill (Core claim-all).

## Open issues

- **OA-D3:** owner review of `Social` (47 states) and the two Components fixes (W5-Z asks; needed by W11).
- **Example data** follows one consistent history (@jay: Free streak 1, play streak 4 days). Numbers are illustrative.
  - Room revealed: winners +55 each against 110 lost.
  - Payout math isn't modeled.
- **Claims** was designed in W3-C (`core/claims/*`). W5-C adds only the Claims row in the You menu and "Claim all" in deletion.

## Notes for D and Z

- **New copy for the owner** (W5-Z), by surface. The full text is on the artboards and in `screens.md`.
  - **Round detail:** "Discuss on Farcaster", "Verify this round", "N strays won", "You picked Crime with 25 points." / "Unflocked, +36 points."
  - **Verify:**
    - "Everything here is public. Check it yourself, or let your browser check your entry."
    - "Verify my entry", "Your entry counted, exactly as you sealed it."
    - The six step titles ("Receipt found on this device" … "Totals add up").
    - "Your entry doesn't check out." / "Keep your receipt. It proves what you sealed." / "Report this".
    - "No receipt on this device" / "Free picks and receipts stay on the device you sealed them on…", "Stakes entries don't need this…", "Check the totals only", "Re-runs the whole tally from the public bundle."
  - **Profile:** "Only you see this. Show it in Settings.", "Private", "Not shared", "Still running", "Questions by @jay".
  - **Boards:**
    - "Winners from the Oct 10 round, by stray streak."
    - "Current stray streaks. Refunds and voided days don't break them."
    - "Wins this week, Oct 5–11. Ties go to net result."
    - "Average split quality of questions that ran. At least 2 questions."
    - "You need 2 questions that ran to appear here."
    - "Only verified players appear on boards."
    - "Nobody here yet." / "Stakes rounds count once they're final."
  - **Submit:**
    - "Two sides, no right answer. Up to 3 a day.", "Same as option 1. Make them differ."
    - "What gets through" with its three lines.
    - "It's in the queue." / "The flock votes on it now…"
    - "Not this one." / "It has a right answer. Questions need two fair sides." / "That's 3 turned down this week. At 5, submissions pause for 7 days."
    - "A person will check this one." / "The automatic check couldn't decide…"
    - "Submissions are paused until Sat, Oct 17."
  - **Queue:** "Vote on what runs next. Admins schedule from the top.", "Top 50. Scores fade over a few days, so new questions get a look.", "The queue is empty. Somebody has to ask.", "Yours".
  - **Rooms:**
    - "Private rounds with people you know. Room points only, never your own."
    - "No rooms yet. Start one and send the link."
    - "Mirror the daily question" / "Write our own", "Up to 50 members. Everyone starts with 500 room points."
    - "Anyone with the link can join while there's room (8 of 50).", "A room round counts once 3 members with accounts at least a day old play…"
    - "You get 500 room points to play with. Room rounds never touch your points, streaks or boards."
    - "Separate from your daily pick. You can pick differently here."
    - "Didn't count toward the minimum (account under a day old)", "Room points only. Room rounds don't count on the global boards."
  - **Settings:**
    - "You need at least one you can sign in with.", "Can't remove while it has unclaimed payouts", "Stays linked until you delete your account", "We keep your country and a one-way ID. Nothing else."
    - Merge-pending notice: "Sign in to @jay_old", "Cancel merge".
    - "Coinbase didn't confirm your details." and the country-mismatch caption.
    - "Applies to rounds locked after you save."
    - "During a break you get no game notifications, whatever these say."
    - "Lowering it works right away. Raising it waits 24 hours.", "Rising to 250 USDC in 23:41:12".
    - Break flow: "Take a break", "You can't end a break early. You can make it longer.", "Start a 30-day break", "You're on a permanent break.", "Ask to lift your break?", "Your break ends Wed, Apr 21 at 4:10pm."
    - Delete flow: "Before you go", "You can still claim later with the wallet that entered, even without an account.", the four "What deleting does" lines, "You can't delete your account yet.", "Delete your account?" / "Keep my account".
- **For W11/W12 builds.** Artboard ids are in Paper (layer names match `screens.md`). Overlay screens put the scrim and sheet in an absolute `overlay` frame; crop nothing (Social screens have no notes bands).
