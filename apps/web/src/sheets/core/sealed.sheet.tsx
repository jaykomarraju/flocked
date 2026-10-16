// Core flow › Sealed (Paper `core/sealed/{pick-known,pick-lost}/{mobile,tablet,desktop}`): the real
// SealedView in the real ShellFrame with Paper's example data, signed in (avatar "J", 640 points):
// "100 duck-sized horses" sealed with 25 points, 04:13:37 to the reveal, 1,204 in with the live dot.
// `pick-lost` is the same entry when this device doesn't have the pick ("Pick not on this device").
// Mobile is a short screen (844 tall). The toggle shows Stakes, as Paper draws it.
import type { SealedViewProps } from '../../features/sealed/SealedView';
import { SealedView } from '../../features/sealed/SealedView';
import type { SheetDef } from '../types';
import { CoreArtboard, EXAMPLE_PLAYER, EXAMPLE_TODAY } from './frames';

const noop = () => undefined;

const STATES = ['pick-known', 'pick-lost'] as const;
type State = (typeof STATES)[number];
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

/** Paper's sealed entry: 25 points, the reveal 04:13:37 away. */
const SEALED: Omit<SealedViewProps, 'breakpoint' | 'pick'> = {
  date: EXAMPLE_TODAY.date,
  mode: 'free',
  onModeChange: noop,
  question: EXAMPLE_TODAY.question,
  stake: 25n,
  revealInMs: (4 * 3600 + 13 * 60 + 37) * 1000,
  entrants: EXAMPLE_TODAY.entrants,
  pool: EXAMPLE_TODAY.pool,
  live: true,
  onRemind: noop,
  onInvite: noop,
};

const PICK: Record<State, string | null> = {
  'pick-known': EXAMPLE_TODAY.options[1].label,
  'pick-lost': null,
};

const sheet: SheetDef = {
  name: 'core/sealed',
  artboards: STATES.flatMap((state) => BREAKPOINTS.map((bp) => `${state}/${bp}`)),
  render: (state, breakpoint) => (
    <CoreArtboard breakpoint={breakpoint} player={EXAMPLE_PLAYER} short>
      <SealedView breakpoint={breakpoint} pick={PICK[state as State]} {...SEALED} />
    </CoreArtboard>
  ),
};

export default sheet;
