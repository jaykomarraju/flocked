// Shared drawing for the Core-flow overlay artboards (Paper page `Core flow`): signed-out Today with
// Paper's example data (`core/today/open-signed-out/*`), drawn by the real TodayView inside the real
// ShellFrame at an artboard's breakpoint, with an overlay (a scrim and a dialog) over the whole
// artboard. The onboarding and sign-in sheets draw their dialogs on top of it.
//
// The overlay is any inline dialog (`Modal inline`, `BottomSheet inline`): its scrim fills the
// artboard. Paper pads a centred modal's scrim by 16 (the Modal's fixed layout does too); an inline
// Modal gets that from its own `scrimClassName`.
import type { ReactNode } from 'react';
import { ShellFrame } from '../../layout/ShellFrame';
import { TodayView } from '../../screens/TodayView';
import type { SheetBreakpoint } from '../types';

const noop = () => undefined;

/** Mobile overlay artboards are 844 tall (docs/design/README.md "Screen conventions (Core flow)"). */
export const MOBILE_OVERLAY_HEIGHT = 844;

/** Paper's example round: "Thursday, Oct 8", 04:12:37 to close, 1,204 in, 30,100 points. */
export const EXAMPLE_TODAY = {
  date: 'Thursday, Oct 8',
  question: 'Would you rather fight one horse-sized duck or 100 duck-sized horses?',
  options: [
    { value: '0', label: 'One horse-sized duck' },
    { value: '1', label: '100 duck-sized horses' },
  ],
  crowdHint: 'Would-you-rather days split 63/37 on average.',
  remainingMs: (4 * 3600 + 12 * 60 + 37) * 1000,
  entrants: 1204,
  pool: 30_100n,
} as const;

export interface CoreArtboardProps {
  breakpoint: SheetBreakpoint;
  /** The dialog over the artboard, drawn inline (scrim and dialog). */
  overlay?: ReactNode;
}

/**
 * Signed-out Today at a breakpoint, light, as the Core-flow artboards draw it: 380 wide and 844 tall
 * on mobile (clipped like Paper), 768 or 1120 wide and as tall as the content from tablet up.
 */
export function CoreArtboard({ breakpoint, overlay }: CoreArtboardProps) {
  const width = breakpoint === 'mobile' ? 380 : breakpoint === 'tablet' ? 768 : 1120;
  return (
    <div data-theme="light" style={{ width }}>
      <ShellFrame
        breakpoint={breakpoint}
        header={{ user: null, onSignIn: noop, onSignOut: noop }}
        active="today"
        overlay={overlay}
        artboard={breakpoint === 'mobile' ? { height: MOBILE_OVERLAY_HEIGHT } : {}}
      >
        <TodayView
          breakpoint={breakpoint}
          date={EXAMPLE_TODAY.date}
          mode="free"
          onModeChange={noop}
          question={EXAMPLE_TODAY.question}
          options={EXAMPLE_TODAY.options}
          pick={null}
          onPick={noop}
          crowdHint={EXAMPLE_TODAY.crowdHint}
          remainingMs={EXAMPLE_TODAY.remainingMs}
          entrants={EXAMPLE_TODAY.entrants}
          pool={EXAMPLE_TODAY.pool}
          live
          signedIn={false}
          onSignIn={noop}
        />
      </ShellFrame>
    </div>
  );
}
