# Screen inventory

Paper file: **Flocked** (`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`). Naming and export rules
are in [README.md](README.md). Tokens: [`packages/shared/design-tokens.json`](../../packages/shared/design-tokens.json).

Freeze status values: `draft` (in progress), `review` (ready for the owner), `frozen` (signed off; changes go
through Z, plan.md 2.7).

## Foundations

Paper page `Foundations`. Freeze: OA-D1.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `foundations/color/light-dark/desktop` | Design_Language.md "Color tokens" | tokens `color.light`, `color.dark` | light and dark palettes, contrast table | `exports/foundations/color__light-dark__desktop.png` | review |
| `foundations/type/light/desktop` | Design_Language.md "Typography" | tokens `font`, `type` | 13 type roles | `exports/foundations/type__light__desktop.png` | review |
| `foundations/space-shape-motion/light/desktop` | Design_Language.md "Shape and layout", "Motion" | tokens `space`, `radius`, `border`, `motion`, `breakpoints` | spacing scale, radius, borders, focus ring, motion table | `exports/foundations/space-shape-motion__light__desktop.png` | review |
| `foundations/mascot/light/desktop` | Design_Language.md "Mascot" | mascot poses (placeholder) | neutral, smug, walking away, shocked, flock | `exports/foundations/mascot__light__desktop.png` | review |
| `foundations/mascot/dark/desktop` | Design_Language.md "Mascot" | mascot poses (placeholder) | same five poses on dark | `exports/foundations/mascot__dark__desktop.png` | review |

### Contrast (WCAG 2.2)

AA needs 4.5:1 for body text and 3:1 for large text (≥ 24px, or ≥ 18.66px at 700) and for UI component
boundaries. Ratios are computed from the token hex values.

| Pair | Light | Dark | AA result and usage rule |
| --- | --- | --- | --- |
| ink on bg | 17.24 | 16.77 | Pass, all text |
| ink on surface | 18.42 | 15.25 | Pass, all text |
| muted on bg | 4.77 | 6.66 | Pass, all text. Light muted is `#6E6E6E` (owner decision, Oct 8, 2026; was `#8A8A8A` at 3.23) |
| muted on surface | 5.10 | 6.06 | Pass, all text |
| accentInk on accent | 3.28 | 6.04 | **Light passes large text only.** Every label on accent is Fredoka 700 ≥ 20px (Design_Language "Typography"). Dark `accentInk` is `#121212` (Oct 8 decision) and passes AA for all text. Numbers on the winning option card stay Inter 600 tabular at 32px (large text, passes 3:1; see W3-C handoff) |
| accent text on bg | 3.07 | 6.04 | Light passes large text only. Accent-colored text only at ≥ 24px (UNFLOCKED uses the 28px `result` role) |
| ink on accent | 5.62 | n/a | Pass. The fallback if a small label ever has to sit on the accent |
| line on bg | 1.22 | 1.34 | Decorative dividers only. Anything interactive uses an ink border (2px, 17:1) |
| scrim | `#141414` 40% | `#000000` 60% | Not a text color. Dims the page behind sheets and dialogs; the sheet or dialog keeps its 2px ink border |

## Components

Paper page `Components`. Freeze: OA-D1. Each sheet has a light and a dark artboard (1120 wide); on the canvas,
one row per sheet, light at x 0 and dark at x 1200. Dark artboards use `--color-dark-*` tokens only; the mascot art
keeps its fixed outline and wool colors (Foundations rule), with legs and shock lines in dark ink.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `components/option-card/{light,dark}/desktop` | Client app (Today, Reveal) | option card | idle, hover, pressed, selected, focus, disabled, revealed-win, revealed-loss (with "Your pick" pill), rounding note | `exports/components/option-card__{light,dark}__desktop.png` | review |
| `components/actions/{light,dark}/desktop` | Client app (Today) | primary CTA pill, secondary pill, mode toggle, tabs | CTA default, pressed, loading, disabled; secondary default, hover/pressed, disabled, small; toggle Free, Stakes, Stakes hidden (static label); tabs active, rest, hover | `exports/components/actions__{light,dark}__desktop.png` | review |
| `components/stake-selector/{light,dark}/desktop` | Client app (Today) | stake selector | Free: preset picked, slider between presets, low balance (presets above the balance disabled); Stakes: fixed, over the daily cap | `exports/components/stake-selector__{light,dark}__desktop.png` | review |
| `components/round-status/{light,dark}/desktop` | Client app (Today, Sealed, Reveal) | countdown, entrant/pool counter, padlock sealed badge, sealed pick, split bars | countdown to close and to reveal (hh:mm:ss), note on the one exception: the unsealing countdown is m:ss (Oct 9 decision, W5-C); counter Free and Stakes; badge and locked pick; bars equal, settled with win accent, tie (refund), extreme (<1% / >99%) | `exports/components/round-status__{light,dark}__desktop.png` | review |
| `components/result-card/{light,dark}/desktop` | Client app (Reveal); Decision log (voice lines) | result card | unflocked (winLine(38)), got flocked (lossLine(62)), refunded (tie), unflocked provisional with "Final at" (Stakes) | `exports/components/result-card__{light,dark}__desktop.png` | review |
| `components/feedback/{light,dark}/desktop` | Client app | toast/error, empty state, skeleton, offline banner | toast with action, error with retry, error with a known cause (4xx), empty state (neutral sheep), skeleton of Today, offline banner under the mobile header | `exports/components/feedback__{light,dark}__desktop.png` | review |
| `components/lists/{light,dark}/desktop` | Client app (Leaderboards, Archive, Profile) | list row, leaderboard row, avatar | archive rows (win, loss, refunded) with mini split; leaderboard default, live stray streak (accent pill), you; avatar 64/40/32/24 | `exports/components/lists__{light,dark}__desktop.png` | review |
| `components/forms-overlays/{light,dark}/desktop` | Client app (Submit, Settings, Onboarding) | form field, modal, bottom sheet | field empty, focus, error; onboarding modal (card 1 of 3) on a scrim; bottom sheet (Stakes verification) | `exports/components/forms-overlays__{light,dark}__desktop.png` | review |
| `components/navigation/{light,dark}/desktop` | Client app | nav bar (mobile), header (desktop and mobile) | nav bar active on each of Today, Archive, Boards, Rooms, You; desktop header signed in (Today) and signed out (Boards); mobile header, with the note that the balance slot shows points in Free and the 30-day net in Stakes (Oct 9 decision, W5-C; replaced "balance hidden in Stakes") | `exports/components/navigation__{light,dark}__desktop.png` | review |

Mascot poses (on the component list in wave-2.md) live on the Foundations page, light and dark.

## Core flow

Paper page `Core flow`. Freeze: OA-D2. Each state has `mobile` (380), `tablet` (768) and `desktop` (1120)
artboards. On the canvas, one row per state (mobile at x 0, tablet at x 460, desktop at x 1308). Mobile uses the
mobile header and the five-tab nav bar. Tablet and desktop use the desktop header and centre the same content in a
560 column. Screens are light only; dark mode maps through the tokens, as on the component sheets.
Exports are at `exports/core/<screen>__<state>__<breakpoint>.png`.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `core/onboarding/card-1/{mobile,tablet,desktop}` | Client app (Onboarding) | onboarding modal over signed-out Today | card 1 of 3, "Pick the side fewer people pick", neutral sheep | `exports/core/onboarding__card-1__{mobile,tablet,desktop}.png` | review |
| `core/onboarding/card-2/{mobile,tablet,desktop}` | Client app (Onboarding) | onboarding modal | card 2 of 3, "Picks stay sealed until just after 9pm ET", smug sheep | `exports/core/onboarding__card-2__{mobile,tablet,desktop}.png` | review |
| `core/onboarding/card-3/{mobile,tablet,desktop}` | Client app (Onboarding) | onboarding modal | card 3 of 3, "The Flock loses. Strays win.", walking-away sheep, CTA "Sign in to play" | `exports/core/onboarding__card-3__{mobile,tablet,desktop}.png` | review |
| `core/sign-in/browser/{mobile,tablet,desktop}` | Identity and personhood (Identities); Client app | sign-in sheet (mobile), modal (tablet up) | Farcaster, wallet, email code; note that email can't create an account | `exports/core/sign-in__browser__{mobile,tablet,desktop}.png` | review |
| `core/sign-in/email-code/{mobile,tablet,desktop}` | Identity and personhood (Identities) | sign-in sheet | 6-digit code field with focus ring, "Sign in", resend link | `exports/core/sign-in__email-code__{mobile,tablet,desktop}.png` | review |
| `core/sign-in/mini-app/{mobile,tablet,desktop}` | Client app (mini app context) | sign-in sheet | Farcaster account from the mini app context, "Continue as @jay", wallet fallback | `exports/core/sign-in__mini-app__{mobile,tablet,desktop}.png` | review |
| `core/today/open-signed-out/{mobile,tablet,desktop}` | Client app (Today) | `/` | signed out: no stake selector, header "Sign in", CTA "Sign in to play" | `exports/core/today__open-signed-out__{mobile,tablet,desktop}.png` | review |
| `core/today/open-free/{mobile,tablet,desktop}` | Client app (Today); Modes: Free and Stakes | `/` | Free, signed in, pick made, preset 25, countdown to close, live count, crowd hint | `exports/core/today__open-free__{mobile,tablet,desktop}.png` | review |
| `core/today/open-stakes/{mobile,tablet,desktop}` | Client app (Today); Compliance (30-day net) | `/` | Stakes, verified: fixed 5 USDC, USDC counter, 30-day net in the header | `exports/core/today__open-stakes__{mobile,tablet,desktop}.png` | review |
| `core/today/open-stakes-unverified/{mobile,tablet,desktop}` | Client app (Today, Entry flow (Stakes) step 1) | `/` | Stakes shown to an unverified user: verify callout, CTA "Verify with Coinbase" (opens the verification sheet) | `exports/core/today__open-stakes-unverified__{mobile,tablet,desktop}.png` | review |
| `core/today/config-warning/{mobile,tablet,desktop}` | Round lifecycle (non-default close); Sealed picks (config check) | `/` | Stakes with non-default values shown prominently (stake 10, min 30) with change-log IDs | `exports/core/today__config-warning__{mobile,tablet,desktop}.png` | review |
| `core/today/dst-notice/{mobile,tablet,desktop}` | Round lifecycle (DST days) | `/` | Free on Oct 31: "Clocks go back tonight", 25-hour round, countdown above 24 h | `exports/core/today__dst-notice__{mobile,tablet,desktop}.png` | review |
| `core/today/sealing/{mobile,tablet,desktop}` | Client app (Entry flow (Free) step 2) | `/` | CTA loading "Sealing", other option disabled, note | `exports/core/today__sealing__{mobile,tablet,desktop}.png` | review |
| `core/sealed/pick-known/{mobile,tablet,desktop}` | Client app (Sealed) | `/` (state) | sealed badge, locked pick and stake, voice line, countdown to reveal, "Remind me", "Invite friends" | `exports/core/sealed__pick-known__{mobile,tablet,desktop}.png` | review |
| `core/sealed/pick-lost/{mobile,tablet,desktop}` | Client app (Sealed); Entry flow (Free) step 2 (local storage) | `/` (state) | sealed entry whose plaintext isn't on this device: "Pick not on this device" | `exports/core/sealed__pick-lost__{mobile,tablet,desktop}.png` | review |
| `core/reveal/unsealing/{mobile,tablet,desktop}` | Real-time and the reveal (Reveal choreography); Client app (Reveal) | `/` (state) | after close, before the beacon: "Unsealing in 1:42", final count (no live dot), equal ink bars with "Your pick", note | `exports/core/reveal__unsealing__{mobile,tablet,desktop}.png` | review |
| `core/reveal/counting/{mobile,tablet,desktop}` | Real-time and the reveal (Reveal choreography) | `/` (state) | after the beacon, until `revealed`: "Counting the flock…", equal bars, note | `exports/core/reveal__counting__{mobile,tablet,desktop}.png` | review |
| `core/reveal/win/{mobile,tablet,desktop}` | Client app (Reveal); Design_Language (Motion, Voice) | `/` (state) | Free win, end state: 62/38 split, accent on the winning bar, UNFLOCKED card (winLine(38)), share-card preview, Share, "The next question is already live"; motion notes band | `exports/core/reveal__win__{mobile,tablet,desktop}.png` | review |
| `core/reveal/loss/{mobile,tablet,desktop}` | Client app (Reveal); Design_Language (Motion, Voice) | `/` (state) | Free loss: winning bar still gets the accent, your side ink, GOT FLOCKED card (lossLine(62)), shocked sheep; motion notes (flock slides in) | `exports/core/reveal__loss__{mobile,tablet,desktop}.png` | review |
| `core/reveal/refund/{mobile,tablet,desktop}` | Settlement and payout math (Refund rules); `reasons.ts` | `/` (state) | headcount tie: 50/50, no accent, "Refunded" card with rule 3's line, stake returned; notes band with motion notes and all 8 refund lines | `exports/core/reveal__refund__{mobile,tablet,desktop}.png` | review |
| `core/reveal/provisional/{mobile,tablet,desktop}` | Real-time and the reveal (Stakes "Final at"); Compliance (30-day net) | `/` (state) | Stakes win before final: 59/41, "Provisional. Final at 11:03pm" chip, "Payout, once final 11.75 USDC", 30-day net in the header; notes (veto re-renders as refunded) | `exports/core/reveal__provisional__{mobile,tablet,desktop}.png` | review |
| `core/reveal/mode-toggle/{mobile,tablet,desktop}` | Modes: Free and Stakes (Rules shared by both modes) | `/` (state) | a Free player toggled to Stakes: Stakes split without "Your pick", "You didn't play Stakes this round", totals, link back; notes band | `exports/core/reveal__mode-toggle__{mobile,tablet,desktop}.png` | review |
| `core/reveal/next-live/{mobile,tablet,desktop}` | Real-time and the reveal (next round open during the reveal); `GET /rounds/today` (`previousRoundId`) | `/` | Today for the next round (Oct 9, no pick yet, CTA disabled) with a "Last round: Unflocked, +38 points · See the reveal" strip | `exports/core/reveal__next-live__{mobile,tablet,desktop}.png` | review |
| `core/stakes-entry/verify-sheet/{mobile,tablet,desktop}` | Client app (Entry flow (Stakes) step 1); Compliance (Age and terms, Responsible play) | sheet (mobile), modal (tablet up) over unverified Stakes Today | "Stakes needs a verified account", 18+ and terms checkboxes, "Verify with Coinbase", "Not now", footer "18+ only · Responsible play" | `exports/core/stakes-entry__verify-sheet__{mobile,tablet,desktop}.png` | review |
| `core/stakes-entry/pending/{mobile,tablet,desktop}` | Client app (Entry flow (Stakes) step 3) | `/` | user operation sent: CTA loading "Confirming", other option disabled, "Waiting for Base to include your entry" | `exports/core/stakes-entry__pending__{mobile,tablet,desktop}.png` | review |
| `core/stakes-entry/error/{mobile,tablet,desktop}` | Client app (Entry flow); feedback sheet (error) | `/` | entry failed: VOICE.error box with Retry above the CTA, selection kept, CTA live | `exports/core/stakes-entry__error__{mobile,tablet,desktop}.png` | review |
| `core/stakes-entry/mismatch/{mobile,tablet,desktop}` | Sealed picks (Round config check) | `/` | onchain config differs from the published one: ink-bordered refusal notice with error icon and "See what doesn't match", CTA disabled | `exports/core/stakes-entry__mismatch__{mobile,tablet,desktop}.png` | review |
| `core/claims/list/{mobile,tablet,desktop}` | Client app (Claims); `api/claims.ts` | `/claims` | "Ready to claim 17.67 USDC" with "Claim all", rows (won, refunded ready; one not open until 11:03pm), destination wallet note | `exports/core/claims__list__{mobile,tablet,desktop}.png` | review |
| `core/claims/claim-all/{mobile,tablet,desktop}` | Client app (Claims) | sheet (mobile), modal (tablet up) | confirm "Claim 17.67 USDC": the two ready payouts, wallet, the one that opens later, CTA "Claim 17.67 USDC", "Not now" | `exports/core/claims__claim-all__{mobile,tablet,desktop}.png` | review |
| `core/claims/pending/{mobile,tablet,desktop}` | Client app (Claims) | `/claims` | claim transaction in flight: CTA loading "Claiming", rows "Claiming", "Waiting for Base to confirm" | `exports/core/claims__pending__{mobile,tablet,desktop}.png` | review |
| `core/claims/empty/{mobile,tablet,desktop}` | Client app (Claims) | `/claims` | nothing to claim: neutral sheep, "Nothing to claim. The flock owes you nothing.", "Back to Today" | `exports/core/claims__empty__{mobile,tablet,desktop}.png` | review |
| `core/global/loading/{mobile,tablet,desktop}` | Client app; feedback sheet (skeleton) | `/` | Today skeleton, line-filled blocks, no shimmer | `exports/core/global__loading__{mobile,tablet,desktop}.png` | review |
| `core/global/error/{mobile,tablet,desktop}` | Client app; Design_Language (Voice: Error) | `/` | page failed to load: shocked sheep, VOICE.error, "Retry" | `exports/core/global__error__{mobile,tablet,desktop}.png` | review |
| `core/global/offline/{mobile,tablet,desktop}` | Client app; Design_Language (Voice: Offline) | `/` | offline banner under the header (in the column from tablet up), CTA disabled, countdown keeps running | `exports/core/global__offline__{mobile,tablet,desktop}.png` | review |
| `core/global/empty/{mobile,tablet,desktop}` | Client app; Design_Language (Voice: Empty state) | `/` | no round (schedule gap): neutral sheep, "No question yet. The sheep are deliberating.", "See past rounds" | `exports/core/global__empty__{mobile,tablet,desktop}.png` | review |
| `core/global/blocked-region/{mobile,tablet,desktop}` | Compliance (Geo-fencing); Client app (Today) | `/` | Stakes hidden by region: static "Free" label instead of the mode toggle, otherwise Free Today | `exports/core/global__blocked-region__{mobile,tablet,desktop}.png` | review |
| `core/global/self-excluded/{mobile,tablet,desktop}` | Compliance (Responsible play: self-exclusion) | `/` | static "Free" label, break notice "You're on a break until Nov 7." with "Claims and refunds still work", both options disabled, no stake or CTA | `exports/core/global__self-excluded__{mobile,tablet,desktop}.png` | review |

On the canvas, W3-C.2 rows start at y 18000. Reveal rows with a notes band (win, loss, refund, provisional,
mode-toggle) take two 1200 slots because their mobile artboards run to about 1,600–1,900px tall.

### Core flow decisions (W3-C)

- **30-day Stakes net result:** in the header's balance slot whenever the Stakes mode is selected ("30 days: +12
  USDC", Inter 500 14px, ink). The points balance sits there in Free, so the Stakes UI always shows it without adding
  a row to Today. It links to the Stakes history under You.
- **Responsible-gambling link in Stakes onboarding:** a persistent "Responsible play" text link in the footer of the
  Stakes verification sheet, under "Not now", next to the 18+ line (drawn in W3-C.2). Settings carries the same link
  (W5-C).
- **Notices on Today:** a non-default config gets a 2px ink-bordered notice above the question (it changes the
  stakes, so it is the loudest thing after the question). The DST notice uses the read-only style (1.5px line
  border). Neither uses the accent.

### Core flow decisions (W3-C.2)

- **Notes bands:** reveal artboards (win, loss, refund, provisional, mode-toggle) end in a band below the screen
  (`notes (not part of the screen)`: surface fill, 2px dashed muted top border) with the motion notes, and on refund
  the eight refund lines. The band is part of the export, so crop it when using these PNGs as screenshot baselines.
- **Reveal layout:** question, split bars (option order, never sorted; ink "Your pick" pill on your side), result
  card, share-card preview with the accent Share CTA (the one primary action), then "The next question is already
  live" as a tappable card with the next question and its close countdown. Bars are the reveal visual; the revealed
  option-card states stay for Round detail.
- **Accent on a loss:** the winning bar still fills with the accent (it is the winning bar); your side and the GOT
  FLOCKED card stay monochrome.
- **Unsealing countdown:** "Unsealing in 1:42" in m:ss, as the spec writes it (never above 10:00, since beaconDelay ≤
  600s). Close and reveal countdowns keep hh:mm:ss. The counter loses its live dot once entries close.
- **Refunds without a tally:** rules 1, 2, 3 and 5 keep the split (one-sided reads 100% / 0%); rules 4, 6, 7 and 8
  replace the bars with the final entrant count.
- **Mode toggle:** the reveal opens on the mode you played; the other mode's segment is disabled until that mode
  reveals. Switching cross-fades the split; each mode's bars animate once per round per device. No result card or
  Share for a mode you didn't play.
- **Next question live:** besides the closing card on the reveal, Today for the next round shows a read-only "Last
  round" strip with the result and "See the reveal" while `previousRoundId` is set. The CTA stays disabled until a
  pick.
- **Verification sheet:** carries the 18+ attestation and terms acceptance as two checkboxes (Compliance "Age and
  terms"); "Verify with Coinbase" is disabled until both are ticked (drawn ticked). Footer: "18+ only · Responsible
  play".
- **Stakes errors:** a failed entry shows the feedback error box above the CTA and keeps the selection; a config
  mismatch reuses the config notice slot with the error icon, and the CTA is disabled.
- **Claims:** a Stakes surface, so the header shows the 30-day net; mobile nav has You active, and the desktop header
  has no active link (Claims is reached from the avatar). "Claim all" claims only ready payouts and confirms first in
  a sheet (modal from tablet up), because the destination wallet and the not-yet-open payout need saying.
- **Global states:** blocked region and self-exclusion both swap the toggle for the static "Free" label. Self-exclusion
  keeps the question visible with both options disabled and no CTA; loading, error and empty keep the header and nav.

## Social

Paper page `Social`. Freeze: OA-D3. Surfaces `social` (Round detail, Archive, Verify, Profile, Leaderboards, the
You menu, Submit, Queue, Rooms) and `settings`, both on this page. Each state has `mobile` (380), `tablet` (768) and
`desktop` (1120) artboards, built on the Core flow layout: mobile header and five-tab nav bar; from tablet up the
desktop header and the content in a 560 column. Screens are light only, as on Core flow. On the canvas, one row per
state, 2400 apart (mobile x 0, tablet x 460, desktop x 1308), in bands: round, archive and verify from y 0; profile
and boards from y 19200; You menu, submit and queue from y 38400; rooms from y 57600; settings from y 76800. The
`kit/shell/<tab>/<breakpoint>` artboards at y −1600 hold the header and nav for each active tab; they are build
scaffolding and aren't exported. Exports are at `exports/social/<screen>__<state>__<breakpoint>.png`.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `social/round/settled/{mobile,tablet,desktop}` | Client app (Round detail); Profiles, leaderboards and rooms | `/r/:id` | Archive active; back link, date, question, "Asked by @woolgatherer · split quality 0.82"; Free and Stakes sections with split bars (accent on the winner, "Your pick" in the mode you played), entrants, pool and winners count (Stakes "Final"); your result box; "Discuss on Farcaster" and "Verify this round". No primary CTA | `exports/social/round__settled__{mobile,tablet,desktop}.png` | review |
| `social/round/voided/{mobile,tablet,desktop}` | Client app (Round detail); Settlement and payout math (Refund rules, rule 4) | `/r/:id` | both modes voided before close: no bars, rule 4's line and the final entrant count per mode; "Verify this round" | `exports/social/round__voided__{mobile,tablet,desktop}.png` | review |
| `social/archive/list/{mobile,tablet,desktop}` | Client app (Archive) | `/archive` | rounds Oct 10 to Oct 4, newest first: list rows with date · mode, question, mini split (accent on the winner, tie all ink) and your result (Unflocked, Got flocked, Refunded, Not played in muted); "Show older rounds" | `exports/social/archive__list__{mobile,tablet,desktop}.png` | review |
| `social/verify/overview/{mobile,tablet,desktop}` | Client app (Verify); Settlement and payout math (Settlement output) | `/r/:id/verify` | mode toggle; "Your entry" card with the "Verify my entry" CTA; Bundle (hash, manifest, formula), Chunks (3 hashes and sizes), Timelock (drand round, signature verified), Onchain (lock leaf, commitment root and anchor, manifest anchor) with Basescan links; `npx @flocked/verify` block | `exports/social/verify__overview__{mobile,tablet,desktop}.png` | review |
| `social/verify/entry-passed/{mobile,tablet,desktop}` | Client app (Verify: "Verify my entry") | `/r/:id/verify` | six passed steps (receipt on device, receipt signature, pick decrypted, found in chunk, under the anchored root, totals add up) under "Your entry counted, exactly as you sealed it."; bundle details collapsed; CLI block | `exports/social/verify__entry-passed__{mobile,tablet,desktop}.png` | review |
| `social/verify/entry-failed/{mobile,tablet,desktop}` | Client app (Verify: "Verify my entry") | `/r/:id/verify` | error box "Your entry doesn't check out." with "Report this"; steps 1–4 pass, step 5 fails (not under the anchored root), step 6 not checked; CLI block | `exports/social/verify__entry-failed__{mobile,tablet,desktop}.png` | review |
| `social/verify/no-receipt/{mobile,tablet,desktop}` | Client app (Verify); Entry flow (Free) step 2 (local storage) | `/r/:id/verify` | step 1 fails (no receipt on this device), steps 2–6 not checked; note that Stakes entries check against `Entered` from any device; "Check the totals only" | `exports/social/verify__no-receipt__{mobile,tablet,desktop}.png` | review |
| `social/profile/own/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Profiles); Compliance (Responsible play: 30-day net) | `/u/:handle` (own) | You active (mobile); avatar 64, @jay, "Edit profile"; Free and Stakes stat boxes (rounds, win rate, stray streak with "Still running", best, play streak, net); Stakes net +48.20 USDC with a padlock and "Only you see this. Show it in Settings."; four recent results; "Questions by @jay" (used with split quality, in the queue with score, scheduled) | `exports/social/profile__own__{mobile,tablet,desktop}.png` | review |
| `social/profile/other/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Profiles) | `/u/:handle` | @woolgatherer: no edit; stats per mode; Stakes net "Private" ("Not shared"); recent results; questions with split quality | `exports/social/profile__other__{mobile,tablet,desktop}.png` | review |
| `social/boards/strays/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Leaderboards) | `/leaderboards` | Boards active; tabs (Strays today active; the tab row clips on mobile), Free/Stakes toggle, "Winners from the Oct 10 round, by stray streak."; seven rows (rank, avatar 40, handle, best caption, streak), accent pill on the top row only; your row pinned (48 @jay); "Only verified players appear on boards." | `exports/social/boards__strays__{mobile,tablet,desktop}.png` | review |
| `social/boards/streaks/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Leaderboards) | `/leaderboards` | Streaks active: current stray streaks, "Refunds and voided days don't break them.", accent pill on the top row only, your row pinned | `exports/social/boards__streaks__{mobile,tablet,desktop}.png` | review |
| `social/boards/weekly/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Leaderboards) | `/leaderboards` | Weekly active: wins Oct 5–11 with net-result captions (ties by net), no accent, your row pinned (112 @jay) | `exports/social/boards__weekly__{mobile,tablet,desktop}.png` | review |
| `social/boards/creators/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Leaderboards); Question pipeline step 5 | `/leaderboards` | Creators active: average split quality (0.94 to 0.74) with "N questions ran", no accent, "You need 2 questions that ran to appear here." | `exports/social/boards__creators__{mobile,tablet,desktop}.png` | review |
| `social/boards/empty/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Leaderboards); Design_Language (Voice: Empty state) | `/leaderboards` | Weekly, Stakes: neutral sheep, "Nobody here yet.", "Stakes rounds count once they're final.", verified footer | `exports/social/boards__empty__{mobile,tablet,desktop}.png` | review |
| `social/you/menu/{mobile,tablet,desktop}` | Client app (Navigation) | You sheet (mobile), avatar menu (tablet up) | mobile: sheet over the page, stopping above the nav (You active), rows @jay "Your profile", Submit a question, Question queue, Claims "2 ready", Settings; tablet and desktop: 280-wide menu under the avatar (focus ring), no scrim | `exports/social/you__menu__{mobile,tablet,desktop}.png` | review |
| `social/submit/form/{mobile,tablet,desktop}` | Question pipeline step 1; Core game rules (question format) | `/submit` | live validation: question 55 / 120, option 1 with "Add emoji", option 2 in the error state ("Same as option 1. Make them differ."), category chips, "What gets through" box, "2 of 3 left today", Submit disabled | `exports/social/submit__form__{mobile,tablet,desktop}.png` | review |
| `social/submit/queued/{mobile,tablet,desktop}` | Question pipeline steps 2–3 | `/submit` (result) | moderation passed: "It's in the queue.", question card "Score 0 · just now", CTA "See the queue", "Submit another" with "1 of 3 left today" | `exports/social/submit__queued__{mobile,tablet,desktop}.png` | review |
| `social/submit/rejected/{mobile,tablet,desktop}` | Question pipeline step 2 (reject with reason) | `/submit` | moderation result box "Not this one." with the reason and the 3-of-5 warning, form refilled and valid, Submit enabled, "1 of 3 left today" | `exports/social/submit__rejected__{mobile,tablet,desktop}.png` | review |
| `social/submit/review/{mobile,tablet,desktop}` | Question pipeline step 2 (refusal or failure → admin review) | `/submit` (result) | "A person will check this one.", question card "Waiting for review", "Back to the queue" (no accent) | `exports/social/submit__review__{mobile,tablet,desktop}.png` | review |
| `social/submit/blocked/{mobile,tablet,desktop}` | Question pipeline; `limits.questionBlockUntil` (5 rejections in 7 days) | `/submit` | notice "Submissions are paused until Sat, Oct 17." with the reason, whole form disabled, Submit disabled, "See the queue" | `exports/social/submit__blocked__{mobile,tablet,desktop}.png` | review |
| `social/queue/list/{mobile,tablet,desktop}` | Question pipeline step 3; Client app (Queue) | `/queue` | Top / New tabs, "Submit a question"; six rows with up/down vote buttons and score (one voted up, one voted down, your own row "Yours" with voting disabled); "Top 50" caption | `exports/social/queue__list__{mobile,tablet,desktop}.png` | review |
| `social/queue/empty/{mobile,tablet,desktop}` | Question pipeline step 3; Design_Language (Voice: Empty state) | `/queue` | neutral sheep, "The queue is empty. Somebody has to ask.", "Submit a question" | `exports/social/queue__empty__{mobile,tablet,desktop}.png` | review |
| `social/rooms/list/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Rooms) | `/rooms` | three rooms with members, question source, room points and today's status (Sealed, Open, Not entered); CTA "Create a room", "Join with a code" | `exports/social/rooms__list__{mobile,tablet,desktop}.png` | review |
| `social/rooms/empty/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Rooms) | `/rooms` | neutral sheep, "No rooms yet. Start one and send the link.", CTA "Create a room", "Join with a code" | `exports/social/rooms__empty__{mobile,tablet,desktop}.png` | review |
| `social/rooms/create/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Rooms) | sheet (mobile), modal (tablet up) over `/rooms` | name field 12 / 48, question source radio cards (mirror the daily question, selected; write our own), "Up to 50 members…500 room points", CTA "Create room", "Not now" | `exports/social/rooms__create__{mobile,tablet,desktop}.png` | review |
| `social/rooms/invite/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Rooms: invite link, anti-farming) | sheet (mobile), modal (tablet up) over `/rooms/:id` | invite link with "Copy", CTA "Share invite", capacity (8 of 50), the 3-qualifying-members rule; close icon on the modal | `exports/social/rooms__invite__{mobile,tablet,desktop}.png` | review |
| `social/rooms/join/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Rooms) | invite landing | "Join Night owls?", inviter, face pile, "6 members · Writes its own questions", 500 room points box, CTA "Join room", "Not now" | `exports/social/rooms__join__{mobile,tablet,desktop}.png` | review |
| `social/rooms/round/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Rooms: room round, room points) | `/rooms/:id` | room header with "Invite", Round / Board tabs, "Your room points 740", close countdown, question, option cards (one picked), "Separate from your daily pick", stake selector in room points, "5 of 8 in", CTA "Seal my pick" | `exports/social/rooms__round__{mobile,tablet,desktop}.png` | review |
| `social/rooms/revealed/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Rooms: member picks after the reveal) | `/rooms/:id` | room split 33/67 with accent and "Your pick", UNFLOCKED card (winLine(33), +55 room points), member picks with results (one entry "Didn't count toward the minimum"), who didn't play | `exports/social/rooms__revealed__{mobile,tablet,desktop}.png` | review |
| `social/rooms/board/{mobile,tablet,desktop}` | Profiles, leaderboards and rooms (Rooms: room leaderboard) | `/rooms/:id` (Board tab) | Points / Wins this week / Streaks segments, eight members by room points, your row highlighted, no accent, "Room points only" caption | `exports/social/rooms__board__{mobile,tablet,desktop}.png` | review |

## Settings

Paper page `Social` (surface `settings`). Freeze: OA-D3. Mobile has You active; tablet and desktop show no active
header link (Settings is reached from the avatar menu). Exports are at
`exports/settings/<screen>__<state>__<breakpoint>.png`.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `settings/main/overview/{mobile,tablet,desktop}` | Client app (Settings); Identity and personhood (Identities); Compliance (Responsible play) | `/settings` | Profile; Sign-in methods (wallet's Remove disabled with the unclaimed-payouts reason, Coinbase not removable, "Link another"); Stakes verification (verified, country); creator payout wallet; Privacy checkboxes (card amounts on, Stakes net off); Notifications "6 of 9 on"; Responsible play (stake cap, "Take a break", resources link); Account ("Sign out", "Delete account") | `exports/settings/main__overview__{mobile,tablet,desktop}.png` | review |
| `settings/identities/merge-pending/{mobile,tablet,desktop}` | Identity and personhood (Merging accounts) | `/settings` | notice "Merge pending": the wallet belongs to @jay_old, sign in to it to merge; what the kept account takes; expiry; CTA "Sign in to @jay_old", "Cancel merge" | `exports/settings/identities__merge-pending__{mobile,tablet,desktop}.png` | review |
| `settings/verification/unverified/{mobile,tablet,desktop}` | Identity and personhood (Personhood); Compliance (Age and terms) | `/settings` | "Not verified", what is stored, CTA "Verify with Coinbase", "18+ only · Responsible play" | `exports/settings/verification__unverified__{mobile,tablet,desktop}.png` | review |
| `settings/verification/failed/{mobile,tablet,desktop}` | Identity and personhood (Personhood); Compliance (Geo-fencing) | `/settings` | error box "Coinbase didn't confirm your details.", CTA "Try again", 18+ footer, country-mismatch caption | `exports/settings/verification__failed__{mobile,tablet,desktop}.png` | review |
| `settings/wallet/edit/{mobile,tablet,desktop}` | Client app (Settings: creator payout wallet); `me.ts` `prefs.creatorPayoutWallet` | sheet (mobile), modal (tablet up) over `/settings` | radio cards for the two linked wallets and "None" (treasury), "Applies to rounds locked after you save.", CTA "Save wallet", "Not now" | `exports/settings/wallet__edit__{mobile,tablet,desktop}.png` | review |
| `settings/notifications/list/{mobile,tablet,desktop}` | Client app (Settings: notifications); `me.ts` `notificationPrefs` | `/settings/notifications` | Farcaster / Push / Email segments, nine event checkboxes (six on), break caption | `exports/settings/notifications__list__{mobile,tablet,desktop}.png` | review |
| `settings/cap/edit/{mobile,tablet,desktop}` | Compliance (Responsible play: daily stake cap) | sheet (mobile), modal (tablet up) over `/settings` | current cap, "New cap" field 250 USDC, "Lowering it works right away. Raising it waits 24 hours.", CTA "Raise to 250 USDC", "Not now" | `exports/settings/cap__edit__{mobile,tablet,desktop}.png` | review |
| `settings/cap/pending/{mobile,tablet,desktop}` | Compliance (Responsible play: 24-hour raise); `limits.pendingCap` | `/settings` | cap 100 USDC with a read-only box "Rising to 250 USDC in 23:41:12", when it was raised, "Cancel increase" | `exports/settings/cap__pending__{mobile,tablet,desktop}.png` | review |
| `settings/exclusion/choose/{mobile,tablet,desktop}` | Compliance (Responsible play: self-exclusion) | `/settings/break` | 7 days, 30 days (selected), 6 months, Permanent with end dates; "You can't end a break early."; CTA "Start a 30-day break"; resources link | `exports/settings/exclusion__choose__{mobile,tablet,desktop}.png` | review |
| `settings/exclusion/confirm/{mobile,tablet,desktop}` | Compliance (Responsible play: self-exclusion) | sheet (mobile), modal (tablet up) | "Start a 30-day break?", end date, "Claims and refunds still work.", CTA "Start my break", "Not now" | `exports/settings/exclusion__confirm__{mobile,tablet,desktop}.png` | review |
| `settings/exclusion/active/{mobile,tablet,desktop}` | Compliance (Responsible play: self-exclusion) | `/settings` | break notice (self-excluded lines), "Make it longer", stake cap, resources link, "Delete account" disabled "Not during a break" | `exports/settings/exclusion__active__{mobile,tablet,desktop}.png` | review |
| `settings/exclusion/permanent/{mobile,tablet,desktop}` | Compliance (Responsible play: permanent exclusion) | `/settings` | "You're on a permanent break.", "Ask to lift it" disabled until 6 months in, with the 7-day cooling-off | `exports/settings/exclusion__permanent__{mobile,tablet,desktop}.png` | review |
| `settings/exclusion/lift-request/{mobile,tablet,desktop}` | Compliance (Responsible play: lift request) | sheet (mobile), modal (tablet up) | "Ask to lift your break?" with the date it lifts, CTA "Ask to lift", "Not now" | `exports/settings/exclusion__lift-request__{mobile,tablet,desktop}.png` | review |
| `settings/exclusion/lift-pending/{mobile,tablet,desktop}` | Compliance (Responsible play: lift request); `limits.selfExclusion.liftEffectiveAt` | `/settings` | "Your break ends Wed, Apr 21 at 4:10pm.", when it was asked, claims still work; no actions | `exports/settings/exclusion__lift-pending__{mobile,tablet,desktop}.png` | review |
| `settings/delete/unclaimed/{mobile,tablet,desktop}` | Identity and personhood (Account deletion) | `/settings/delete` | "Before you go" card: 17.67 USDC unclaimed, two payouts, CTA "Claim all"; claiming later by wallet; what deleting does (four lines); "Delete my account" | `exports/settings/delete__unclaimed__{mobile,tablet,desktop}.png` | review |
| `settings/delete/blocked/{mobile,tablet,desktop}` | Identity and personhood (Account deletion: not while a round isn't final) | `/settings/delete` | notice "You can't delete your account yet." (round final at 11:03pm), "Delete my account" disabled, break and suspension caption | `exports/settings/delete__blocked__{mobile,tablet,desktop}.png` | review |
| `settings/delete/confirm/{mobile,tablet,desktop}` | Identity and personhood (Account deletion) | sheet (mobile), modal (tablet up) | "Delete your account?", can't be undone, CTA "Delete my account", "Keep my account" | `exports/settings/delete__confirm__{mobile,tablet,desktop}.png` | review |

### Social and settings decisions (W5-C)

- **Header and avatar menu:** tablet and desktop header links are Today, Archive, Boards and Rooms. Submit, Queue,
  Claims and Settings sit in the avatar menu (Decision log, Oct 9); pages reached from it show no active link, and
  mobile has You active. The Core flow headers and the navigation sheet still show a "Questions" link (W5-C
  handoff, spec issues).
- **You menu:** on mobile the You tab opens a bottom sheet that stops above the nav bar, so the active You tab stays
  visible and closes it. From tablet up it is a 280-wide menu card under the avatar (focus ring on the avatar), with
  no scrim. Rows: your profile, Submit a question, Question queue, Claims (ready count), Settings.
- **Round detail:** both modes stacked, each with split bars (the Reveal visual, more compact than the revealed option
  cards), entrants, pool and winners count. Your result shows only under the mode you played. Rule 4 (and 6, 7, 8)
  replace the bars with the refund line and the final entrant count, as on Reveal. Verify keeps Archive active.
- **Verify my entry:** a numbered list of six checks (receipt, receipt signature, decrypt, chunk, anchored root,
  totals), each passed, failed (error icon, 600 message) or "Not checked" (dashed, muted). A failure gets the error
  box with "Report this"; the CLI command closes every Verify state.
- **Profile:** stats per mode as two blocks, no toggle. The Stakes net is private by default: your own profile shows
  it with a padlock and "Only you see this. Show it in Settings."; another player's shows "Private".
- **Boards:** tabs plus the Free/Stakes toggle. The live stray-streak accent pill goes on the top row only (Strays
  today, Streaks); Weekly, Creators and room boards use no accent. Your row is pinned at the bottom in the row/you
  style. A footer says only verified players appear.
- **Submit and Queue:** live validation uses the field error state; the moderation outcome is a result screen
  (queued, review) or a box above the refilled form (rejected). The 7-day block disables the whole form. Queue votes
  are 36px ink-bordered chevron buttons; your vote fills with ink, and your own question can't be voted on.
- **Rooms:** room pages keep the header's global points; the room balance sits in a strip under the Round / Board
  tabs, and every room amount says "room points". Member picks appear only after the reveal, with a note on any entry
  that didn't count toward the 3-entrant minimum.
- **Settings rows:** section headings in the title role (Fredoka 600 22px), line-divided rows with a 96px action
  slot, checkboxes (from the verification sheet) instead of switches, since the kit has no switch. Notices that need
  action have a 2px ink border; read-only notices a 1.5px line border.
- **Sheets:** bottom sheet on mobile, 400-wide modal on a scrim from tablet up (Core flow pattern), dismissed with a
  "Not now" text button.

## Cards and notifications

Paper page `Cards and notifications`. Freeze: OA-D4. Cards are light only (they are images on other apps' feeds).
Each card artboard is the card frame `card__<kind>__<state>__<variant>` at the exact variant size plus a
`notes (not part of the card)` band with the satori note and the 25% check; the export is the card frame (README
"Exporting"). On the canvas, one row per state, 1600 apart: `og` at x 0, `embed` at 1400, `square` at 2800 (wins,
losses, streak, teaser, round); refunds in a second band, `og` at 4400, `embed` at 5800, `square` at 7200.

### Share cards

Spec: "Share cards and distribution" (Card content). Route: `GET /cards/:shareId/:variant.png` (result, teaser) and
`GET /rounds/:id/card/:variant.png` (round); rendered by satori (W10-A). Each row covers `og`, `embed` and `square`.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `cards/result/free-win/{og,embed,square}` | Share cards and distribution (Card content) | result card | Free win: "Free · Oct 12", question, 62/38 split, accent on the winning bar, "Your pick", UNFLOCKED +86 pts, smug sheep, handle and avatar, wordmark and URL | `exports/cards/result__free-win__{og,embed,square}.png` | review |
| `cards/result/free-win-streak/{og,embed,square}` | Share cards and distribution (Card content: stray streak if ≥ 2) | result card | free win plus the "3-day stray streak" pill in the header row | `exports/cards/result__free-win-streak__{og,embed,square}.png` | review |
| `cards/result/free-loss/{og,embed,square}` | Share cards and distribution | result card | Free loss: pick on the 62% side, winning bar still accent, GOT FLOCKED in ink, the flock | `exports/cards/result__free-loss__{og,embed,square}.png` | review |
| `cards/result/stakes-win-multiple/{og,embed,square}` | Share cards and distribution (Stakes amounts off, the default) | result card | Stakes win with the multiple: UNFLOCKED 2.6x | `exports/cards/result__stakes-win-multiple__{og,embed,square}.png` | review |
| `cards/result/stakes-win-amount/{og,embed,square}` | Share cards and distribution (show amounts on cards) | result card | Stakes win with the amount: UNFLOCKED +16.00 USDC | `exports/cards/result__stakes-win-amount__{og,embed,square}.png` | review |
| `cards/result/stakes-loss/{og,embed,square}` | Share cards and distribution | result card | Stakes loss: GOT FLOCKED, the flock | `exports/cards/result__stakes-loss__{og,embed,square}.png` | review |
| `cards/teaser/sealed/{og,embed,square}` | Share cards and distribution (Share surfaces: pre-reveal share) | teaser card | question and both options as plain outlines, sealed badge, "I sealed my pick. Can you out-think the flock?"; no per-option data (reveal gating) | `exports/cards/teaser__sealed__{og,embed,square}.png` | review |
| `cards/round/free/{og,embed,square}` | Share cards and distribution (Generation: generic round card) | round card | split only: "Free · Oct 12 · 1,204 players", bars, "38% strayed. They won."; no player, pick or handle | `exports/cards/round__free__{og,embed,square}.png` | review |
| `cards/round/stakes/{og,embed,square}` | Share cards and distribution (Generation: generic round card) | round card | as Free, "Stakes · Oct 12 · 214 players" | `exports/cards/round__stakes__{og,embed,square}.png` | review |

### Refund cards

Spec: "Settlement and payout math" (Refund rules); Design_Language.md refund lines. One state per rule and mode,
named after `REFUND_REASONS[].name` in `packages/shared/src/reasons.ts`. No accent on any refund card.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `cards/result/free-refund-too-few-entrants/{og,embed,square}` | Refund rules (rule 1) | result card | room round, 2 players, split kept, rule 1 line | `exports/cards/result__free-refund-too-few-entrants__{og,embed,square}.png` | review |
| `cards/result/free-refund-one-sided/{og,embed,square}` | Refund rules (rule 2) | result card | 100% / 0%, rule 2 line | `exports/cards/result__free-refund-one-sided__{og,embed,square}.png` | review |
| `cards/result/free-refund-headcount-tie/{og,embed,square}` | Refund rules (rule 3) | result card | 50% / 50%, the "Refunded (tie only)" line | `exports/cards/result__free-refund-headcount-tie__{og,embed,square}.png` | review |
| `cards/result/free-refund-voided/{og,embed,square}` | Refund rules (rule 4) | result card | entrant count and sealed badge instead of bars, rule 4 line | `exports/cards/result__free-refund-voided__{og,embed,square}.png` | review |
| `cards/result/free-refund-commitment-not-anchored/{og,embed,square}` | Refund rules (rule 7); Decision log Oct 12 | result card | entrant count and sealed badge, rule 7 line ("Points returned.") | `exports/cards/result__free-refund-commitment-not-anchored__{og,embed,square}.png` | review |
| `cards/result/free-refund-beacon-unavailable/{og,embed,square}` | Refund rules (rule 8); Decision log Oct 12 | result card | entrant count and sealed badge, rule 8 line ("Points returned.") | `exports/cards/result__free-refund-beacon-unavailable__{og,embed,square}.png` | review |
| `cards/result/stakes-refund-too-few-entrants/{og,embed,square}` | Refund rules (rule 1) | result card | 14 players (under 20), 64% / 36%, rule 1 line | `exports/cards/result__stakes-refund-too-few-entrants__{og,embed,square}.png` | review |
| `cards/result/stakes-refund-one-sided/{og,embed,square}` | Refund rules (rule 2) | result card | 100% / 0%, rule 2 line | `exports/cards/result__stakes-refund-one-sided__{og,embed,square}.png` | review |
| `cards/result/stakes-refund-headcount-tie/{og,embed,square}` | Refund rules (rule 3) | result card | 50% / 50%, tie line | `exports/cards/result__stakes-refund-headcount-tie__{og,embed,square}.png` | review |
| `cards/result/stakes-refund-voided/{og,embed,square}` | Refund rules (rule 4) | result card | entrant count and sealed badge, rule 4 line | `exports/cards/result__stakes-refund-voided__{og,embed,square}.png` | review |
| `cards/result/stakes-refund-vetoed/{og,embed,square}` | Refund rules (rule 5) | result card | 62% / 38% kept with no accent, rule 5 line | `exports/cards/result__stakes-refund-vetoed__{og,embed,square}.png` | review |
| `cards/result/stakes-refund-timeout/{og,embed,square}` | Refund rules (rule 6) | result card | entrant count instead of bars, rule 6 line | `exports/cards/result__stakes-refund-timeout__{og,embed,square}.png` | review |

### Cards decisions (W6-C)

- **Layout:** Design_Language "Share cards" order, as one flex column with space-between: mode and day label (with
  the streak pill or sealed badge on the right), question (≤ 2 lines in `og` and `embed`, ≤ 3 in `square`), split
  bars (label row with "Your pick" and the % in a 120px right-aligned slot, then the track), the result line with the
  sheep, then handle and avatar left, wordmark and URL right. The square stacks the result line.
- **Result line:** two text runs (`result-label` "UNFLOCKED", `result-value` "+86 pts" / "2.6x" / "+16.00 USDC")
  so the value never breaks alone. Fredoka 700: 88 / 92 / 112px (`og` / `embed` / `square`); the Stakes amount
  drops to 76 / 74px in `og` / `embed` to stay on one line. GOT FLOCKED and "Refunded" are ink.
- **Accent:** only the winning bar, UNFLOCKED, the stray-streak pill, and the smug sheep's glint (README component
  conventions). A loss keeps the accent on the winning bar. Refund cards have none (no winner), so both bars are ink.
  Round cards keep the winning bar but put their line ("38% strayed. They won.") in ink.
- **Refunds:** title "Refunded" (the result-card component's refunded title) plus the why line, exactly as in
  Design_Language's refund table, Inter 600 ≤ 2 lines. Rules 1, 2, 3 and 5 keep the split with "Your pick"; rules
  4, 6, 7 and 8 replace the bars with the entrant count ("1,204 players"), and 4, 7 and 8 add the sealed badge
  because no pick was ever opened. Neutral sheep.
- **Teaser:** the question, both options as plain 2px ink outlines, the sealed badge and "I sealed my pick. Can you
  out-think the flock?" (spec share text) as the big line; no per-option data, no accent. **Round:** no player,
  pick, handle or avatar; the footer keeps only the brand.
- **Mascot:** smug on wins, the five-sheep flock on losses, neutral on refunds, teaser and round. The sheep SVGs keep
  their fixed Foundations colours (raw `#141414` / `#FFFFFF`, and the accent glint). satori should get each pose,
  and the flock, as one inline SVG.
- **25% check:** `get_screenshot` at 1x, downscaled with `sips -Z` to 300 wide (`og`, `embed`) or 270 (`square`).
  The result line, "Refunded" and the teaser line read on every card (16–28px at 25%); the question and the bars
  read; the meta label, "Your pick", the why line and the URL are texture. Each card's notes band records its
  check.
- **satori:** every card is flex only (no grid, no transforms, no tabular figures: the % sits in a fixed slot); bar
  fills are % widths of a fixed track. Each notes band names that card's primitives. Fonts: Fredoka 600/700 and
  Inter 500/600/700 as TTF.
- **Example values:** the Core flow question ("Would you rather fight one horse-sized duck or 100 duck-sized
  horses?"), 62/38, @woolgatherer, "Oct 12", 1,204 Free and 212–214 Stakes players, URL "flocked.app" (a
  placeholder: the spec names no domain).

### Share sheet and share page

Spec: "Share cards and distribution" (Share surfaces). Screen breakpoints, in the band x 9000–11500 (mobile at 9000,
tablet 9460, desktop 10308; rows 2400 apart). Exports at `exports/cards/<screen>__<state>__<breakpoint>.png`.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `cards/share-sheet/result-web/{mobile,tablet,desktop}` | Share cards and distribution (Share surfaces: share sheet) | sheet over `/` (Reveal); modal from tablet up | "Share your result", share-card preview, Wide/Square segment (Wide, with check), share text "Unflocked. 3-day stray streak." + link, CTA "Share" (Web Share API; desktop: "Copy link"), "Copy link" and "Download image" pills, "Not now" | `exports/cards/share-sheet__result-web__{mobile,tablet,desktop}.png` | review |
| `cards/share-sheet/result-mini-app/mobile` | Share surfaces (Farcaster cast composer in the mini app) | sheet in the mini app | CTA "Cast" (composer with the text and the embed), "Copy link", "Download image"; caption "Casts show the card with a Play button."; no segment | `exports/cards/share-sheet__result-mini-app__mobile.png` | review |
| `cards/share-sheet/teaser-web/{mobile,tablet,desktop}` | Share surfaces (pre-reveal share) | sheet over the Sealed screen | "Share the question", "The card shows the question, not your pick.", teaser preview, share text "I sealed my pick. Can you out-think the flock?" + link, same actions | `exports/cards/share-sheet__teaser-web__{mobile,tablet,desktop}.png` | review |
| `cards/share-page/result/{mobile,tablet,desktop}` | Share surfaces (`/s/:shareId`); Distribution hooks (Referral) | `/s/:shareId` | signed-out header, "@woolgatherer · Free · Oct 12", card preview, CTA "Play today's Flocked", "See the round"; head tags in the notes band | `exports/cards/share-page__result__{mobile,tablet,desktop}.png` | review |
| `cards/share-page/teaser-open/{mobile,tablet,desktop}` | Share surfaces (teaser) | `/s/:shareId` before the reveal | "@woolgatherer sealed a pick.", teaser preview, "Closes in 04:12:09", CTA; no round link | `exports/cards/share-page__teaser-open__{mobile,tablet,desktop}.png` | review |
| `cards/share-page/teaser-revealed/{mobile,tablet,desktop}` | Share surfaces (teaser page links to the round after the reveal) | `/s/:shareId` after the reveal | "@woolgatherer sealed a pick. The round has revealed.", teaser preview, CTA, "See the reveal" | `exports/cards/share-page__teaser-revealed__{mobile,tablet,desktop}.png` | review |

### Notifications

Spec: "Notifications". Copy: `packages/shared/src/copy/notifications.ts` (`NOTIFICATION_COPY`, `REFUND_LINES`,
`OUTCOME_NEXT_LIVE`, `EMAIL_CHROME`); the artboards use it verbatim. Surface `notifications`, at x 12000 and up on the
canvas. Notification mocks are neutral (surface rows, line borders, the neutral sheep head as the app icon), not a
copy of Farcaster's or an OS's UI.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `notifications/farcaster/all-events/mobile` | Notifications | Farcaster mini app notification | every event and variant in `NOTIFICATION_EVENTS` order: question_live; closing_soon; outcome win, win without amount, loss, void, refund by rules 4, 7 and 8 (with "The next question is live."); payout_claimable marked not sent; refunded Free (rule 8) and Stakes (rule 5); question_used scheduled and settled; streak_at_risk; question_edited; security_notice × 4 kinds | `exports/notifications/farcaster__all-events__mobile.png` | review |
| `notifications/webpush/all-events/mobile` | Notifications | web push | the same list, payout_claimable included | `exports/notifications/webpush__all-events__mobile.png` | review |
| `notifications/refund-lines/all-rules/desktop` | Notifications; Settlement and payout math (Refund rules) | refund copy table | rules 1–8: the refund line, the outcome push, the refunded push per mode; rules 4, 7 and 8 marked (they never reveal); rules 5 and 6 not sent as an outcome | `exports/notifications/refund-lines__all-rules__desktop.png` | review |
| `notifications/email/outcome-win/{mobile,desktop}` | Notifications (`outcome`, email if verified) | email template | UNFLOCKED +86 pts (accent heading), the share line, "The next question is live." with "Play the next question", CTA "See the reveal"; subject and preheader in the notes band | `exports/notifications/email__outcome-win__{mobile,desktop}.png` | review |
| `notifications/email/outcome-refund/{mobile,desktop}` | Notifications (`outcome`); Refund rules (rule 8) | email template | Free round refunded, rule 8 line, next-live paragraph, CTA "See the round" | `exports/notifications/email__outcome-refund__{mobile,desktop}.png` | review |
| `notifications/email/payout-claimable/{mobile,desktop}` | Notifications (`payout_claimable`) | email template | Ready to claim 17.67 USDC, CTA "Claim 17.67 USDC" | `exports/notifications/email__payout-claimable__{mobile,desktop}.png` | review |
| `notifications/email/refunded/{mobile,desktop}` | Notifications (`refunded`); Refund rules (rule 5) | email template | Stakes round refunded, rule 5 line, "Your refund is waiting in Claims.", CTA "Go to Claims" | `exports/notifications/email__refunded__{mobile,desktop}.png` | review |
| `notifications/email/security-notice/{mobile,desktop}` | Notifications (`security_notice`) | email template | new sign-in with email, CTA "Open Settings", "Security notices are always on." footer (no manage link) | `exports/notifications/email__security-notice__{mobile,desktop}.png` | review |

### Share and notification decisions (W6-C.2)

- **Share sheet actions:** in a browser, the CTA is "Share" (Web Share API), with "Copy link" and "Download image"
  as secondary pills; where Web Share is missing (most desktop browsers) "Copy link" becomes the CTA. In the mini
  app the CTA is "Cast" (the cast composer with the text and the embed card). The Wide/Square segment picks the
  image for Share and Download (`og` or `square`); casts always use `embed`. The sheet closes with "Not now".
- **Share text** (new lines): win "Unflocked." plus " 3-day stray streak." when the streak is ≥ 2; loss "Got
  flocked." or "Got flocked again." after a loss the day before; teaser "I sealed my pick. Can you out-think the
  flock?" (spec). The link follows on its own line.
- **`/s/:shareId`:** signed-out header with no active link, the card preview, one CTA "Play today's Flocked" (also
  the Farcaster embed button), and a round link once the round has revealed. Head tags (notes band): `og:title`,
  `og:description` (the share text), `og:image` (`og.png`), `twitter:card` `summary_large_image`, `fc:miniapp` (and
  `fc:frame`) with `imageUrl` `embed.png` and a `launch_miniapp` button to `/?ref=<ref_code>`. A teaser page keeps
  its teaser images after the reveal and never reads the pick.
- **Notification channels and copy:** the spec's channel column, as `NOTIFICATION_EVENT_CHANNELS`; every other
  channel is `null` (not sent). `outcome` push bodies end with "The next question is live." when a next round
  exists. A refund says why with `REFUND_LINES[refundReason]`; a Stakes refund adds "Your refund is waiting in
  Claims." Rules 5 and 6 arrive only as `refunded` (they come after the reveal); `refunded` carries Free only for
  rules 7 and 8 after the outcome was sent.
- **Limits:** titles ≤ 32 and bodies ≤ 128 characters on Farcaster and web push (the test fills every template with
  worst-case values: a 120-character question, ">99%", "+1,234,567.89 USDC", the longest refund line).
- **Emails:** a 600 column on `bg`, wordmark, one surface panel (heading, body, next-live paragraph and link for
  outcomes, one accent CTA), footer captions ("Manage notifications"; security notices say they're always on).
  Accent only on the CTA and the UNFLOCKED heading. Subject, preheader and build notes are in each notes band.
