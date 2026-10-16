// Core flow › Onboarding (Paper `core/onboarding/card-{1,2,3}/{mobile,tablet,desktop}`): the real
// OnboardingModal on each card, drawn in place over signed-out Today.
import { OnboardingModal } from '../../onboarding/OnboardingModal';
import type { SheetDef } from '../types';
import { CoreArtboard } from './frames';

const noop = () => undefined;

const CARDS = ['card-1', 'card-2', 'card-3'] as const;
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

const sheet: SheetDef = {
  name: 'core/onboarding',
  artboards: CARDS.flatMap((card) => BREAKPOINTS.map((bp) => `${card}/${bp}`)),
  render: (state, breakpoint) => (
    <CoreArtboard
      breakpoint={breakpoint}
      overlay={
        <OnboardingModal
          open
          inline
          initialCard={Math.max(0, CARDS.indexOf(state as (typeof CARDS)[number]))}
          onClose={noop}
          onSignIn={noop}
        />
      }
    />
  ),
};

export default sheet;
