// Core flow › the global states that hide Stakes (Paper `core/global/{blocked-region,self-excluded}/
// {mobile,tablet,desktop}`; spec "Compliance and responsible play" › Geo-fencing and Responsible
// play). Both swap the mode toggle for the static "Free" label and say nothing about why
// (docs/design/screens.md, "Core flow decisions (W3-C.2)" › Global states).
//   blocked-region  Free Today exactly as `core/today/open-free`, with the label instead of the toggle
//   self-excluded   the question stays, with the break notice under it, both options disabled, and
//                   no stake selector and no CTA: there is nothing to do here until the break ends
//
// Both are the real TodayView: `stakesAvailable` false gives the static label, and `onBreak` gives
// the break its notice under the question, its disabled options and its empty foot.
import { breakNotice } from '../../features/stakes/copy';
import type { SheetDef } from '../types';
import { CoreArtboard, EXAMPLE_PLAYER } from './frames';
import { SIGNED_IN } from './today.sheet';

const STATES = ['blocked-region', 'self-excluded'] as const;
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

const sheet: SheetDef = {
  name: 'core/global',
  artboards: STATES.flatMap((state) => BREAKPOINTS.map((bp) => `${state}/${bp}`)),
  render: (state, breakpoint) => (
    <CoreArtboard
      breakpoint={breakpoint}
      player={EXAMPLE_PLAYER}
      today={
        state === 'self-excluded'
          ? { ...SIGNED_IN, pick: null, stakesAvailable: false, onBreak: breakNotice('Nov 7') }
          : { ...SIGNED_IN, stakesAvailable: false }
      }
    />
  ),
};

export default sheet;
