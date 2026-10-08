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
