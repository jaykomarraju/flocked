// Core flow › Reveal (Paper `core/reveal/<state>/{mobile,tablet,desktop}`): the real views in the real
// ShellFrame with Paper's example data, signed in (avatar "J"). Each state draws one artboard row:
//   unsealing  after close, before the beacon: "Unsealing in 1:42", the final count (no live dot),
//              equal ink bars with "Your pick" on "100 duck-sized horses", the note (a short screen)
//   counting   after the beacon: "Counting the flock…", the final count, equal bars, the note
//   next-live  Today for the next round (Friday, Oct 9, nothing picked, the CTA disabled) under the
//              "Last round: Unflocked, +38 points · See the reveal" strip (703 points)
// RevealView draws without motion (`animate` false). The toggle shows Stakes, as Paper draws it. A
// state is one entry in REVEAL; add the others (win, loss, refund, mode-toggle) there.
import type { ReactNode } from 'react';
import { LastRoundStrip } from '../../features/reveal/LastRoundStrip';
import { RevealView, type RevealViewProps } from '../../features/reveal/RevealView';
import { FREE_STAKE_MAX, FREE_STAKE_MIN, FREE_STAKE_PRESETS } from '../../ui/StakeSelector';
import type { SheetBreakpoint, SheetDef } from '../types';
import { CoreArtboard, EXAMPLE_PLAYER, EXAMPLE_TODAY } from './frames';

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

/** One render per state (the artboard row), by breakpoint. */
const REVEAL: Record<string, (breakpoint: SheetBreakpoint) => ReactNode> = {
  unsealing: (breakpoint) => reveal(breakpoint, { phase: 'unsealing', unsealingMs: 102_000 }),
  counting: (breakpoint) => reveal(breakpoint, { phase: 'counting' }),
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
