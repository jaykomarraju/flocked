// Core flow › Today (Paper `core/today/{open-signed-out,open-free,sealing,dst-notice}/{mobile,tablet,
// desktop}`): the real TodayView in the real ShellFrame with Paper's example data. Signed out: "Sign
// in to play" and the Free note. Signed in (avatar "J", 640 points): "100 duck-sized horses" picked
// and the 25 preset; `sealing` spins the CTA, disables the other option and shows the sealing note;
// `dst-notice` is Saturday, Oct 31, the 25-hour round, with the "Clocks go back tonight" notice.
import type { TodayViewProps } from '../../features/today/TodayView';
import { FREE_STAKE_MAX, FREE_STAKE_MIN, FREE_STAKE_PRESETS } from '../../ui/StakeSelector';
import type { SheetDef } from '../types';
import { CoreArtboard, EXAMPLE_PLAYER } from './frames';

const noop = () => undefined;

const STATES = ['open-signed-out', 'open-free', 'sealing', 'dst-notice'] as const;
type State = (typeof STATES)[number];
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

/** Signed in, Free, "100 duck-sized horses" picked, the 25 preset. */
const SIGNED_IN: Partial<TodayViewProps> = {
  signedIn: true,
  pick: '1',
  stake: {
    value: 25,
    onChange: noop,
    min: FREE_STAKE_MIN,
    max: FREE_STAKE_MAX,
    presets: FREE_STAKE_PRESETS,
    balance: 640,
  },
  onSeal: noop,
};

const TODAY: Record<State, Partial<TodayViewProps> | null> = {
  'open-signed-out': null,
  'open-free': SIGNED_IN,
  sealing: { ...SIGNED_IN, sealing: true },
  'dst-notice': {
    ...SIGNED_IN,
    date: 'Saturday, Oct 31',
    notice: {
      title: 'Clocks go back tonight',
      body: 'So this round runs 25 hours. It still closes at 9pm ET.',
    },
    remainingMs: (24 * 3600 + 58 * 60 + 10) * 1000,
    entrants: 86,
    pool: 2_150n,
  },
};

const sheet: SheetDef = {
  name: 'core/today',
  artboards: STATES.flatMap((state) => BREAKPOINTS.map((bp) => `${state}/${bp}`)),
  render: (state, breakpoint) => {
    const today = TODAY[state as State];
    return (
      <CoreArtboard
        breakpoint={breakpoint}
        player={today ? EXAMPLE_PLAYER : null}
        today={today ?? undefined}
      />
    );
  },
};

export default sheet;
