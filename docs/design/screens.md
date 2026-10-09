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
| `components/round-status/{light,dark}/desktop` | Client app (Today, Sealed, Reveal) | countdown, entrant/pool counter, padlock sealed badge, sealed pick, split bars | countdown to close and to reveal; counter Free and Stakes; badge and locked pick; bars equal, settled with win accent, tie (refund), extreme (<1% / >99%) | `exports/components/round-status__{light,dark}__desktop.png` | review |
| `components/result-card/{light,dark}/desktop` | Client app (Reveal); Decision log (voice lines) | result card | unflocked (winLine(38)), got flocked (lossLine(62)), refunded (tie), unflocked provisional with "Final at" (Stakes) | `exports/components/result-card__{light,dark}__desktop.png` | review |
| `components/feedback/{light,dark}/desktop` | Client app | toast/error, empty state, skeleton, offline banner | toast with action, error with retry, error with a known cause (4xx), empty state (neutral sheep), skeleton of Today, offline banner under the mobile header | `exports/components/feedback__{light,dark}__desktop.png` | review |
| `components/lists/{light,dark}/desktop` | Client app (Leaderboards, Archive, Profile) | list row, leaderboard row, avatar | archive rows (win, loss, refunded) with mini split; leaderboard default, live stray streak (accent pill), you; avatar 64/40/32/24 | `exports/components/lists__{light,dark}__desktop.png` | review |
| `components/forms-overlays/{light,dark}/desktop` | Client app (Submit, Settings, Onboarding) | form field, modal, bottom sheet | field empty, focus, error; onboarding modal (card 1 of 3) on a scrim; bottom sheet (Stakes verification) | `exports/components/forms-overlays__{light,dark}__desktop.png` | review |
| `components/navigation/{light,dark}/desktop` | Client app | nav bar (mobile), header (desktop and mobile) | nav bar active on each of Today, Archive, Boards, Rooms, You; desktop header signed in (Today) and signed out (Boards); mobile header | `exports/components/navigation__{light,dark}__desktop.png` | review |

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
