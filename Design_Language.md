# Design note: Flocked visual language

Apply this to all UI, share cards, and copy. Use it alongside the product spec.

## Feel
Minimal, restrained layout with deadpan, slightly cheeky humor. Think "a daily word game's restraint + a smug cartoon sheep." Confident, flat, high contrast. Generous whitespace. Never cluttered, never corporate.

## Color tokens
Light (default):
- --bg: #FAF7F2 (warm off-white)
- --surface: #FFFFFF
- --ink: #141414 (near-black, all primary text)
- --muted: #6E6E6E (secondary text; 4.77:1 on --bg)
- --line: #E6E1D8 (borders, dividers)
- --accent: #FF4F2E (tomato red-orange — the ONLY accent)
- --accent-ink: #FFFFFF (text on accent)
- --scrim: #141414 at 40% (dims the page behind sheets and dialogs)

Dark:
- --bg: #121212, --surface: #1C1C1C, --ink: #F5F2EC, --muted: #9A9A9A, --line: #2C2C2C, --accent: #FF5A3A, --accent-ink: #121212, --scrim: #000000 at 60%

Rules:
- Use the accent sparingly: the winning bar on reveal, the primary CTA, the "UNFLOCKED" result, and streak highlights. Nothing else.
- Use no gradients and no drop shadows. Separate surfaces with flat fills and 1.5–2px borders in --line or --ink.
- Losing states stay monochrome (ink on bg). Winning states get the accent.
- Accent-coloured text only at 24px or larger (it is 3.07:1 on light --bg). For smaller accent emphasis, use an accent fill with a CTA-size label, as the streak pill does.

## Typography
- Headlines and questions: Fredoka (600–700), large and chunky. The daily question is the hero at 32–40px on mobile.
- Body and UI: Inter (400–600).
- Numbers (percentages, stakes, timers): Inter with tabular figures.
- Labels on the accent fill are Fredoka 700 at 20px or larger (light --accent-ink on --accent is 3.28:1, large text only).
- Numerals on the accent fill may use Inter 600 with tabular figures at 24px or larger (WCAG large text, 3:1). Smaller text on the accent follows the label rule above.
- Use sentence case everywhere. ALL CAPS only for result lines: "UNFLOCKED", "GOT FLOCKED".

## Shape and layout
- Radius: 16px on cards and options, 999px on pills and buttons.
- Option buttons are big rounded cards with a 2px ink border. When selected, the card fills with ink and the text turns --bg.
- Use a 4/8px spacing scale. Design mobile-first at a 380px minimum width, single column.
- Use one primary action per screen.

## Mascot
- One smug, unbothered sheep: simple flat shapes, thick rounded outlines in --ink, a white wool body, half-closed eyes, a slight smirk.
- Poses needed: neutral, smug (win), walking away alone (win animation), shocked (loss), a flock of identical sheep (the "got flocked" state).
- The sheep keeps #141414 outlines and white wool in both themes. In dark mode only strokes outside the wool (legs, shock lines) use dark --ink.
- Until final art exists, build simple placeholder SVGs in this style as React components in packages/shared/mascot. Keep it to 2 colors (ink + white) plus the accent where needed.

## Motion
- Reveal: bars start equal, then grow to their headcount shares over 3s with ease-out. The winning bar fills with the accent, then the result card springs up from the bottom.
- Loss: the flock slides in from the side and bunches together. Win: the lone sheep walks off-screen.
- Keep micro-interactions short (150–200ms). Honor prefers-reduced-motion by skipping to the final state with a fade.

## Voice
Short, dry, deadpan. Copy should never explain the joke and never use exclamation points.
- Win: "Unflocked. You and 38% of people out-thought everyone."
- Loss: "You got flocked. 61% thought the same thing you did."
- Sealed: "Your pick is sealed. Nobody can see it. Not even us."
- Empty state: "No question yet. The sheep are deliberating."
- Error: "Something broke. The flock is looking into it."
- Refunded (tie only): "A dead heat. Nobody strayed, so everyone gets their stake back."
- Offline: "You're offline. Nothing can be sealed until you're back."
- Entry rejected at close: "This round just closed. Your pick wasn't sent."
- Daily cap: "You've hit today's cap. The flock will still be here tomorrow."

Refund lines, one per refund reason (`packages/shared/src/reasons.ts`):

| Code | Reason | Line |
| --- | --- | --- |
| 1 | `too_few_entrants` | "Not enough sheep showed up. Everyone gets their stake back." |
| 2 | `one_sided` | "Everyone picked the same side. No strays, no round. Everyone gets their stake back." |
| 3 | `headcount_tie` | The "Refunded (tie only)" line above |
| 4 | `voided` | "This round was called off before it closed. Everyone gets their stake back." |
| 5 | `vetoed` | "The result was challenged and thrown out. Everyone gets their stake back." |
| 6 | `timeout` | "No result was posted in time. Everyone gets their stake back." |
| 7 | `commitment_not_anchored` | "The picks weren't locked in on time, so this round doesn't count. Points returned." |
| 8 | `beacon_unavailable` | "The timelock never opened, so the picks stay sealed. Points returned." |

Core flow (amounts, addresses, dates and times are examples):
- Unsealing: "Entries closed at 9pm. The timelock opens for everyone at once."
- Counting: "The timelock is open. Every pick is being tallied."
- Next question live: "Last round" / "See the reveal"
- Mode toggle, mode not played: "You didn't play Stakes this round." / "Back to your Free result"
- Verification sheet: "I'm 18 or older", "I accept the Stakes terms", "18+ only", "Responsible play"
- Entry pending: "Confirming", "Waiting for Base to include your entry. Usually a few seconds."
- Config mismatch: "This round doesn't match its onchain record", "The published stake is 10 USDC. Onchain it's 50 USDC. We won't build your entry while they differ.", "See what doesn't match"
- Claims: "Stakes payouts and refunds you haven't claimed yet.", "Ready to claim", "2 of 3 are ready. The third opens at 11:03pm.", "Payouts go to the wallet that entered, 0x3f2c…a91c. Claims from rounds you already entered stay open, wherever you are.", "Claim 17.67 USDC", "Two payouts, one transaction. They go to 0x3f2c…a91c.", "The Oct 8 payout opens at 11:03pm. Claim it then.", "Claiming", "Waiting for Base to confirm. Usually a few seconds.", "Nothing to claim. The flock owes you nothing.", "Back to Today"
- Self-excluded: "You're on a break until Nov 7.", "No picks in either mode until then, and no game notifications.", "Claims and refunds still work"

## Share cards
- Follow the same tokens: bg background, ink text, and the accent only on the winning bar and the "UNFLOCKED" line.
- Layout: question on top, split bars in the middle, a big result line, then the mascot pose, handle, and wordmark at the bottom.
- The card must read at thumbnail size in a feed. The result line must be legible at 25% scale.

## Don't
- No gradients, glassmorphism, neon, or 3D.
- No more than one accent color.
- No stock crypto imagery: coins, charts, rockets.
- No emoji in UI chrome. Emoji are allowed only inside user-written question options.
