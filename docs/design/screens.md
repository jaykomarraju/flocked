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
| muted on bg | 3.23 | 6.66 | **Light fails body AA.** Light muted only for text ≥ 24px, placeholders, disabled controls and decoration. Secondary information uses ink at a smaller role. Dark passes. Spec issue: proposed light muted `#6E6E6E` (4.77 on bg, 5.10 on surface) |
| muted on surface | 3.45 | 6.06 | Same rule as muted on bg |
| accentInk on accent | 3.28 | 6.04 | **Light passes large text only.** Every label on accent is Fredoka 700 ≥ 20px (the `cta` role), which counts as large bold text. Dark `accentInk` is `#121212`, the designer's pick (spec issue), and passes AA for all text |
| accent text on bg | 3.07 | 6.04 | Light passes large text only. Accent-colored text only at ≥ 24px (UNFLOCKED uses the 28px `result` role) |
| ink on accent | 5.62 | n/a | Pass. The fallback if a small label ever has to sit on the accent |
| line on bg | 1.22 | 1.34 | Decorative dividers only. Anything interactive uses an ink border (2px, 17:1) |

## Components

Paper page `Components`. Freeze: OA-D1. Each sheet has a light and a dark artboard. `option-card` and `actions`
are built in light and dark (W2-C.2) but not exported yet: the Paper MCP hit its weekly limit. The other seven
sheets are planned and continue in W2-C.3.

| Artboard | Spec heading | Route or component | States covered | Export | Freeze |
| --- | --- | --- | --- | --- | --- |
| `components/option-card/{light,dark}/desktop` | Client app (Today, Reveal) | option card | idle, hover, pressed, selected, focus, disabled, revealed-win, revealed-loss (with "Your pick" pill), rounding note | pending (`exports/components/option-card__{light,dark}__desktop.png`) | draft (built) |
| `components/actions/{light,dark}/desktop` | Client app (Today) | primary CTA pill, secondary pill, mode toggle, tabs | CTA default, pressed, loading, disabled; secondary default, hover/pressed, disabled, small; toggle Free, Stakes, Stakes hidden (static label); tabs active, rest, hover | pending (`exports/components/actions__{light,dark}__desktop.png`) | draft (built) |
| `components/stake-selector/{light,dark}/desktop` | Client app (Today) | stake selector | Free presets + slider; Stakes fixed stake | `exports/components/stake-selector__{light,dark}__desktop.png` | draft |
| `components/round-status/{light,dark}/desktop` | Client app (Today, Sealed, Reveal) | countdown, entrant/pool counter, padlock sealed badge, split bars | bars equal, end states, win accent | `exports/components/round-status__{light,dark}__desktop.png` | draft |
| `components/result-card/{light,dark}/desktop` | Client app (Reveal); Decision log (voice lines) | result card | unflocked, got flocked, refunded, provisional with "Final at" | `exports/components/result-card__{light,dark}__desktop.png` | draft |
| `components/feedback/{light,dark}/desktop` | Client app | toast/error, empty state, skeleton, offline banner | per component | `exports/components/feedback__{light,dark}__desktop.png` | draft |
| `components/lists/{light,dark}/desktop` | Client app (Leaderboards, Archive, Profile) | list row, leaderboard row, avatar | default, you, accent streak | `exports/components/lists__{light,dark}__desktop.png` | draft |
| `components/forms-overlays/{light,dark}/desktop` | Client app (Submit, Settings, Onboarding) | form field, modal, bottom sheet | text, focus, error | `exports/components/forms-overlays__{light,dark}__desktop.png` | draft |
| `components/navigation/{light,dark}/desktop` | Client app | nav bar (mobile), header (desktop) | active tab per destination | `exports/components/navigation__{light,dark}__desktop.png` | draft |

Mascot poses (on the component list in wave-2.md) live on the Foundations page, light and dark.
