// Core flow › Reveal (Paper `core/reveal/<state>/{mobile,tablet,desktop}`): the real views in the real
// ShellFrame with Paper's example data, signed in (avatar "J"). Each state draws one artboard row:
//   unsealing  after close, before the beacon: "Unsealing in 1:42", the final count (no live dot),
//              equal ink bars with "Your pick" on "100 duck-sized horses", the note (a short screen)
//   counting   after the beacon: "Counting the flock…", the final count, equal bars, the note
//   win        Free win, the end state: 62/38, the accent on "100 duck-sized horses" (picked), the
//              UNFLOCKED card (+38 points), the share preview and Share, the next question (703 points)
//   loss       Free loss: 38/62, the accent on the winning "One horse-sized duck", the player's side
//              ink, the GOT FLOCKED card (−25 points), the share preview (640 points)
//   refund     a headcount tie: 50/50, no accent, the Refunded card with rule 3's line, the stake
//              returned, the share preview (665 points)
//   provisional  a Stakes win before the challenge window ends: 59/41, the accent on the player's
//              side, the UNFLOCKED card with the "Provisional. Final at 11:03pm" chip, "Stake 5 USDC"
//              and "Payout, once final 11.75 USDC", the share preview (the 30-day net in the header)
//   mode-toggle  a Free player on Stakes: 59/41, no "Your pick", "You didn't play Stakes this round.",
//              the Stakes totals and the way back; no card, no Share (the 30-day net in the header)
//   next-live  Today for the next round (Friday, Oct 9, nothing picked, the CTA disabled) under the
//              "Last round: Unflocked, +38 points · See the reveal" strip (703 points)
// RevealView draws without motion (`animate` false). The toggle shows Stakes, as Paper draws it. The
// result states run long: the mobile artboard is as tall as the screen, and each ends in Paper's notes
// band (NotesBand, not part of the screen).
import type { ReactNode } from 'react';
import { REFUND_LINES } from '../../features/reveal/copy';
import { LastRoundStrip } from '../../features/reveal/LastRoundStrip';
import { RevealView, type RevealViewProps } from '../../features/reveal/RevealView';
import { ShareBlock, type ShareBlockProps } from '../../features/reveal/ShareBlock';
import type { Balance } from '../../ui/BalanceSlot';
import { FREE_STAKE_MAX, FREE_STAKE_MIN, FREE_STAKE_PRESETS } from '../../ui/StakeSelector';
import type { SheetBreakpoint, SheetDef } from '../types';
import { CoreArtboard, EXAMPLE_PLAYER, EXAMPLE_TODAY } from './frames';
import { NotesBand, type NotesBandProps } from './NotesBand';

const noop = () => undefined;

const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

/** Paper's closed round (Thursday, Oct 8): 1,204 in, 30,100 points, "100 duck-sized horses" picked. */
const CLOSED: Omit<RevealViewProps, 'breakpoint' | 'phase'> = {
  date: EXAMPLE_TODAY.date,
  mode: 'free',
  onModeChange: noop,
  question: EXAMPLE_TODAY.question,
  options: EXAMPLE_TODAY.options.map((o) => o.label),
  entrants: EXAMPLE_TODAY.entrants,
  pool: EXAMPLE_TODAY.pool,
  pick: 1,
  animate: false,
};

/** The reveal of Paper's closed round at a breakpoint, a short screen on mobile. */
function reveal(
  breakpoint: SheetBreakpoint,
  props: Partial<RevealViewProps> & Pick<RevealViewProps, 'phase'>,
) {
  return (
    <CoreArtboard breakpoint={breakpoint} player={EXAMPLE_PLAYER} short>
      <RevealView breakpoint={breakpoint} {...CLOSED} {...props} />
    </CoreArtboard>
  );
}

/** Paper's next round, open during the reveal: "Is a hot dog a sandwich?", 23:57:40 to close. */
const NEXT = {
  question: 'Is a hot dog a sandwich?',
  remainingMs: (23 * 3600 + 57 * 60 + 40) * 1000,
  onOpen: noop,
};

/** The notes bands' text, as Paper writes it (not app copy). */
const PLAYS_ONCE =
  '5. Plays once per round on this device, also when the page loads after the reveal. Share and the next question fade in last.';
const REDUCED = '4. Reduced motion: skip to this end state with a fade (motion.fade).';
const BARS_GROW =
  '1. Bars start equal, then grow to their headcount shares over 3s, ease-out (motion.reveal). Percentages count up with them.';

const NOTES: Record<string, Omit<NotesBandProps, 'breakpoint'>> = {
  win: {
    title: 'Motion notes',
    notes: [
      BARS_GROW,
      '2. As the bars land, the winning bar fills with the accent (motion.fade).',
      '3. Then the result card springs up from the bottom (motion.spring) and the lone sheep walks off-screen (motion.walkOff).',
      REDUCED,
      PLAYS_ONCE,
    ],
  },
  loss: {
    title: 'Motion notes',
    notes: [
      BARS_GROW,
      '2. As the bars land, the winning bar fills with the accent. Your side stays ink; the result card stays monochrome.',
      '3. Then the result card springs up from the bottom (motion.spring) and the flock slides in from the side and bunches together behind it (motion.flock).',
      REDUCED,
      PLAYS_ONCE,
    ],
  },
  refund: {
    title: 'Motion notes',
    notes: [
      '1. Bars start equal and settle level over 3s (motion.reveal). A tie has no winner, so neither bar takes the accent.',
      '2. Then the result card springs up from the bottom (motion.spring). Neutral sheep: no walk-off, no flock.',
      '3. Rules 1, 2, 3 and 5 keep the split (one-sided reads 100% / 0%). Rules 4, 6, 7 and 8 have no tally to show, so the bars give way to the final entrant count.',
      REDUCED,
      '5. Plays once per round on this device. A Stakes refund arrives as a refunded message (a veto re-renders an already shown result as refunded).',
    ],
    more: {
      title:
        'Refund lines, one per reason (reasons.ts codes). The card shows 3. Drafts for the owner via W3-Z; only 3 is a Voice line.',
      lines: [
        '1 · Too few entrants (both): "Not enough sheep showed up. Everyone gets their stake back."',
        '2 · One-sided (both): "Everyone picked the same side. No strays, no round. Everyone gets their stake back."',
        '3 · Headcount tie (both): "A dead heat. Nobody strayed, so everyone gets their stake back."',
        '4 · Voided (both): "This round was called off before it closed. Everyone gets their stake back."',
        '5 · Vetoed (Stakes): "The result was challenged and thrown out. Everyone gets their stake back."',
        '6 · Timeout (Stakes): "No result was posted in time. Everyone gets their stake back."',
        '7 · Commitment not anchored (Free): "The picks weren\'t locked in on time, so this round doesn\'t count. Points returned."',
        '8 · Beacon unavailable (Free): "The timelock never opened, so the picks stay sealed. Points returned."',
      ],
    },
  },
  provisional: {
    title: 'Motion notes',
    notes: [
      BARS_GROW,
      '2. As the bars land, the winning bar fills with the accent (motion.fade).',
      '3. Then the result card springs up from the bottom (motion.spring) and the lone sheep walks off-screen (motion.walkOff).',
      REDUCED,
      '5. Stakes shows the result once the proposal confirms, with Final at (end of the challenge window). At final the chip leaves and the payout moves to Claims. A guardian veto re-renders this card as refunded (rule 5).',
    ],
  },
  'mode-toggle': {
    title: 'Mode toggle notes',
    notes: [
      "1. The reveal opens on the mode you played. The toggle shows the other mode's split once that mode has revealed; until then its segment is disabled (dashed, not focusable).",
      "2. Switching swaps the split with a fade (motion.fade). Each mode's bars run the 3s reveal once per round on this device; after that they show the end state.",
      "3. The header balance slot follows the selected mode: points in Free, the 30-day net in Stakes. No result card or Share for a mode you didn't play.",
    ],
  },
};

/**
 * The result states whose artboards are a half pixel tall at every breakpoint (odd-height exports):
 * Paper exports them 0.25px low.
 */
const HALF_PIXEL = new Set(['refund', 'mode-toggle']);

/**
 * A settled reveal of Paper's closed round as a long screen (the mobile artboard as tall as the
 * content), the header balance, and the state's notes band under it.
 */
function settled(
  state: string,
  breakpoint: SheetBreakpoint,
  balance: Balance,
  props: Partial<RevealViewProps> & Pick<RevealViewProps, 'phase'>,
) {
  return (
    <CoreArtboard
      breakpoint={breakpoint}
      player={{ ...EXAMPLE_PLAYER, balance }}
      notes={<NotesBand breakpoint={breakpoint} {...NOTES[state]!} />}
      halfPixel={HALF_PIXEL.has(state)}
    >
      <RevealView breakpoint={breakpoint} {...CLOSED} next={NEXT} {...props} />
    </CoreArtboard>
  );
}

/** The share preview and Share for the player's Free result (@jay). */
function share(
  breakpoint: SheetBreakpoint,
  props: Pick<ShareBlockProps, 'counts' | 'winner' | 'result'>,
) {
  return (
    <ShareBlock
      breakpoint={breakpoint}
      question={EXAMPLE_TODAY.question}
      handle="jay"
      url="https://flocked.xyz/r/example"
      {...props}
    />
  );
}

/** One render per state (the artboard row), by breakpoint. */
const REVEAL: Record<string, (breakpoint: SheetBreakpoint) => ReactNode> = {
  unsealing: (breakpoint) => reveal(breakpoint, { phase: 'unsealing', unsealingMs: 102_000 }),
  counting: (breakpoint) => reveal(breakpoint, { phase: 'counting' }),
  win: (breakpoint) =>
    settled(
      'win',
      breakpoint,
      { mode: 'free', points: 703 },
      {
        phase: 'revealed',
        counts: [62, 38],
        winner: 1,
        result: {
          result: 'unflocked',
          count: 38,
          total: 100,
          stake: '25 points',
          figure: { label: 'Won', value: '+38 points' },
        },
        share: share(breakpoint, { counts: [62, 38], winner: 1, result: 'unflocked' }),
      },
    ),
  loss: (breakpoint) =>
    settled(
      'loss',
      breakpoint,
      { mode: 'free', points: 640 },
      {
        phase: 'revealed',
        counts: [38, 62],
        winner: 0,
        result: {
          result: 'got-flocked',
          count: 62,
          total: 100,
          stake: '25 points',
          figure: { label: 'Lost', value: '−25 points' },
        },
        share: share(breakpoint, { counts: [38, 62], winner: 0, result: 'got-flocked' }),
      },
    ),
  refund: (breakpoint) =>
    settled(
      'refund',
      breakpoint,
      { mode: 'free', points: 665 },
      {
        phase: 'refunded',
        counts: [50, 50],
        winner: null,
        result: {
          result: 'refunded',
          line: REFUND_LINES.headcount_tie,
          stake: '25 points',
          figure: { label: 'Returned', value: '25 points' },
        },
        share: share(breakpoint, { counts: [50, 50], winner: null, result: 'refunded' }),
      },
    ),
  provisional: (breakpoint) =>
    settled(
      'provisional',
      breakpoint,
      { mode: 'stakes', net: 12_000_000n },
      {
        phase: 'revealed',
        mode: 'stakes',
        entrants: 212,
        pool: 1_060_000_000n,
        counts: [59, 41],
        winner: 1,
        result: {
          result: 'unflocked',
          count: 41,
          total: 100,
          stake: '5 USDC',
          figure: { label: 'Payout, once final', value: '11.75 USDC' },
          finalAt: '11:03pm',
        },
        share: share(breakpoint, { counts: [59, 41], winner: 1, result: 'unflocked' }),
      },
    ),
  'mode-toggle': (breakpoint) =>
    settled(
      'mode-toggle',
      breakpoint,
      { mode: 'stakes', net: 12_000_000n },
      {
        phase: 'revealed',
        mode: 'stakes',
        entrants: 212,
        pool: 1_060_000_000n,
        counts: [59, 41],
        winner: 1,
        notPlayed: { onBack: noop, playedMode: 'free', finalAt: '11:03pm' },
      },
    ),
  'next-live': (breakpoint) => (
    <CoreArtboard
      breakpoint={breakpoint}
      player={{ ...EXAMPLE_PLAYER, balance: { mode: 'free', points: 703 } }}
      today={{
        lastRound: <LastRoundStrip summary="Unflocked, +38 points" onSee={noop} />,
        date: 'Friday, Oct 9',
        question: 'Is a hot dog a sandwich?',
        options: [
          { value: '0', label: 'Yes, technically' },
          { value: '1', label: 'No, never' },
        ],
        crowdHint: 'Yes-or-no days split 58/42 on average.',
        remainingMs: (23 * 3600 + 57 * 60 + 40) * 1000,
        entrants: 38,
        pool: 610n,
        signedIn: true,
        pick: null,
        stake: {
          value: 25,
          onChange: noop,
          min: FREE_STAKE_MIN,
          max: FREE_STAKE_MAX,
          presets: FREE_STAKE_PRESETS,
          balance: 703,
        },
        onSeal: noop,
      }}
    />
  ),
};

const sheet: SheetDef = {
  name: 'core/reveal',
  artboards: Object.keys(REVEAL).flatMap((state) => BREAKPOINTS.map((bp) => `${state}/${bp}`)),
  render: (state, breakpoint) => REVEAL[state]?.(breakpoint) ?? null,
};

export default sheet;
