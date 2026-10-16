// Shared drawing for the Core-flow artboards (Paper page `Core flow`): Today with Paper's example
// data (`core/today/*`), drawn by the real TodayView inside the real ShellFrame at an artboard's
// breakpoint, optionally with an overlay (a scrim and a dialog) over the whole artboard. The Today
// sheet draws its states with it; the onboarding and sign-in sheets draw their dialogs on top of
// signed-out Today; the Sealed and Reveal sheets put their own view in the content column instead of
// Today (`children`), on the 844-tall mobile artboard of a short screen (`short`).
//
// The overlay is any inline dialog (`Modal inline`, `BottomSheet inline`): its scrim fills the
// artboard. Paper pads a centred modal's scrim by 16 (the Modal's fixed layout does too); an inline
// Modal gets that from its own `scrimClassName`.
import type { ReactNode } from 'react';
import { ShellFrame } from '../../layout/ShellFrame';
import { TodayView, type TodayViewProps } from '../../features/today/TodayView';
import type { Balance } from '../../ui/BalanceSlot';
import type { HeaderUser } from '../../ui/Header';
import type { SheetBreakpoint } from '../types';

const noop = () => undefined;

/**
 * Mobile overlay and short-screen artboards are 844 tall (docs/design/README.md "Screen conventions
 * (Core flow)").
 */
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

/** Paper's signed-in player: avatar "J" (no picture), 640 points in the header. */
export const EXAMPLE_PLAYER: { user: HeaderUser; balance: Balance } = {
  user: { handle: 'jay' },
  balance: { mode: 'free', points: 640 },
};

export interface CoreArtboardProps {
  breakpoint: SheetBreakpoint;
  /** The dialog over the artboard, drawn inline (scrim and dialog). */
  overlay?: ReactNode;
  /** The signed-in header (account and balance); signed out ("Sign in") without it. */
  player?: { user: HeaderUser; balance: Balance } | null;
  /** TodayView props over signed-out Today's (Paper's example round, nothing picked). */
  today?: Partial<TodayViewProps>;
  /** A short screen: the mobile artboard is 844 tall, as under an overlay. */
  short?: boolean;
  /** The screen in the content column instead of Today (Sealed, the reveal). */
  children?: ReactNode;
}

/**
 * Today (or `children`) at a breakpoint, light, as the Core-flow artboards draw it: 380 wide on mobile
 * (844 tall and clipped like Paper under an overlay or on a short screen, otherwise as tall as the
 * content), 768 or 1120 wide and as tall as the content from tablet up.
 */
export function CoreArtboard({
  breakpoint,
  overlay,
  player = null,
  today,
  short = false,
  children,
}: CoreArtboardProps) {
  const width = breakpoint === 'mobile' ? 380 : breakpoint === 'tablet' ? 768 : 1120;
  return (
    <div data-theme="light" style={{ width }}>
      <ShellFrame
        breakpoint={breakpoint}
        header={{
          user: player?.user ?? null,
          balance: player?.balance ?? null,
          onSignIn: noop,
          onSignOut: noop,
        }}
        active="today"
        overlay={overlay}
        artboard={
          breakpoint === 'mobile' && (overlay || short) ? { height: MOBILE_OVERLAY_HEIGHT } : {}
        }
      >
        {children ?? (
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
            {...today}
          />
        )}
      </ShellFrame>
    </div>
  );
}
