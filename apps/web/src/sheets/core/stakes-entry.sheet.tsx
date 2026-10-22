// Core flow › Stakes entry (Paper `core/stakes-entry/{verify-sheet,pending,error,mismatch}/{mobile,
// tablet,desktop}`; spec "Client app" › Entry flow (Stakes)): the real screens in the real ShellFrame
// over Paper's example round, on the Stakes side of the toggle.
//   verify-sheet  the verification sheet (mobile) or modal (tablet up) over unverified Stakes Today,
//                 both boxes ticked, so "Verify with Coinbase" is live
//   pending       the user operation is out: the CTA loads "Confirming", the other option is
//                 disabled, and the note says Base is still including the entry
//   error         the entry failed: the error box with Retry above the CTA, the pick kept, CTA live
//   mismatch      the onchain config differs from the published one: the refusal notice (the config
//                 notice slot with the error mark and "See what doesn't match") and a dead CTA
import { VOICE } from '@flocked/shared';
import { VerifyOverlay } from '../../features/stakes/VerifyOverlay';
import {
  MISMATCH_DETAILS,
  MISMATCH_TITLE,
  PENDING_CTA,
  PENDING_NOTE,
  mismatchBody,
} from '../../features/stakes/copy';
import type { ConfigMismatch } from '../../features/stakes/configCheck';
import type { TodayViewProps } from '../../features/today/TodayView';
import type { SheetBreakpoint, SheetDef } from '../types';
import { CoreArtboard } from './frames';
import {
  NON_DEFAULT_ROUND,
  STAKES,
  STAKES_PLAYER,
  UNVERIFIED,
  UNVERIFIED_PLAYER,
} from './today.sheet';

const noop = () => undefined;

const STATES = ['verify-sheet', 'pending', 'error', 'mismatch'] as const;
type State = (typeof STATES)[number];
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

/** Paper's mismatch: the published stake is 10 USDC, the chain says 50. */
const MISMATCHES: readonly ConfigMismatch[] = [
  { field: 'stake', published: '10 USDC', onchain: '50 USDC' },
];

/** The three states TodayView draws on its own (everything but the sheet). */
const TODAY: Record<Exclude<State, 'verify-sheet'>, Partial<TodayViewProps>> = {
  pending: {
    ...STAKES,
    sealing: true,
    ctaLoadingLabel: PENDING_CTA,
    workingNote: PENDING_NOTE,
  },
  error: { ...STAKES, error: { message: VOICE.error, onRetry: noop } },
  mismatch: {
    ...NON_DEFAULT_ROUND,
    notice: {
      variant: 'refusal',
      title: MISMATCH_TITLE,
      body: mismatchBody(MISMATCHES),
      link: { label: MISMATCH_DETAILS, onClick: noop },
    },
    sealDisabled: true,
  },
};

/** The verification sheet over unverified Stakes Today, drawn in place (scrim and sheet). */
function verifySheet(breakpoint: SheetBreakpoint) {
  return (
    <CoreArtboard
      breakpoint={breakpoint}
      player={UNVERIFIED_PLAYER}
      today={UNVERIFIED}
      overlay={
        <VerifyOverlay
          breakpoint={breakpoint}
          inline
          ageRequired={18}
          defaultChecked
          onVerify={noop}
          onClose={noop}
        />
      }
    />
  );
}

const sheet: SheetDef = {
  name: 'core/stakes-entry',
  artboards: STATES.flatMap((state) => BREAKPOINTS.map((bp) => `${state}/${bp}`)),
  render: (state, breakpoint) =>
    state === 'verify-sheet' ? (
      verifySheet(breakpoint)
    ) : (
      <CoreArtboard
        breakpoint={breakpoint}
        player={STAKES_PLAYER}
        today={TODAY[state as Exclude<State, 'verify-sheet'>]}
      />
    ),
};

export default sheet;
