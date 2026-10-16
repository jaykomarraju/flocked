// The screen frame of the Core-flow artboards (docs/design/README.md "Screen conventions (Core
// flow)"): on mobile the mobile header (56), the content (16px side padding, 24px gaps) and the
// five-tab nav bar (72); from tablet up the desktop header and the content centred in a 560 column
// (28px gaps). Presentational: the live shell (AppShell) and the design sheets (sheets/core/frames)
// both draw screens through it.
//
// Live, the mobile nav bar sticks to the bottom of the viewport and the mobile header to the top
// (except on Today, where the question owns the top of the screen), and dialogs portal themselves
// onto the page. Drawn as an artboard (`artboard`), everything sits in the flow as Paper draws it: a
// fixed-height artboard (the 844-tall mobile overlays) clips what runs past it, and the overlay
// covers the whole frame.
import type { ReactNode } from 'react';
import type { TabId } from '../nav';
import type { Breakpoint } from '../theme';
import type { Balance } from '../ui/BalanceSlot';
import { Header, type HeaderUser } from '../ui/Header';
import { MobileHeader } from '../ui/MobileHeader';
import { NavBar } from '../ui/NavBar';
import s from './ShellFrame.module.css';

export interface ShellHeaderProps {
  /** The signed-in account, or null for the "Sign in" pill. */
  user: HeaderUser | null;
  /** The balance slot (signed in only). */
  balance?: Balance | null;
  onSignIn: () => void;
  /** The avatar menu's "Sign out" (tablet and desktop; mobile signs out from the You sheet). */
  onSignOut: () => void;
  /** Starts with the avatar menu open (design sheets). */
  menuOpen?: boolean;
}

export interface ShellFrameProps {
  breakpoint: Breakpoint;
  /** The header, or null for none. */
  header: ShellHeaderProps | null;
  /**
   * The active tab: the nav bar's on mobile; the header's link from tablet up, where `you` (pages
   * reached from the avatar menu) shows no active link.
   */
  active: TabId | null;
  /** Mobile: the You tab and the header's avatar toggle the You sheet. */
  onYou?: () => void;
  /** Whether the You sheet is open. */
  youOpen?: boolean;
  /** The You sheet's id (the You tab's `aria-controls` while it is open). */
  youSheetId?: string;
  /** Under the header: the offline banner (on tablet and desktop it spans the content column). */
  banner?: ReactNode;
  /** A dialog over the screen (scrim and dialog). */
  overlay?: ReactNode;
  /**
   * Draw as a Paper artboard (design sheets): everything in the flow, the overlay over the whole
   * frame, and with `height` a fixed-height artboard that clips like Paper's.
   */
  artboard?: { height?: number };
  children: ReactNode;
}

const noop = () => undefined;

export function ShellFrame({
  breakpoint,
  header,
  active,
  onYou = noop,
  youOpen = false,
  youSheetId,
  banner,
  overlay,
  artboard,
  children,
}: ShellFrameProps) {
  const mobile = breakpoint === 'mobile';
  const live = artboard === undefined;
  return (
    <div
      className={s.frame}
      data-breakpoint={breakpoint}
      data-live={live || undefined}
      data-today={active === 'today' || undefined}
      style={artboard?.height === undefined ? undefined : { height: artboard.height }}
    >
      <div className={s.top}>
        {header === null ? null : mobile ? (
          <MobileHeader
            user={header.user}
            balance={header.balance}
            onSignIn={header.onSignIn}
            onYou={onYou}
            youOpen={youOpen}
          />
        ) : (
          <Header
            active={active === 'you' ? null : active}
            breakpoint={breakpoint}
            user={header.user}
            balance={header.balance}
            onSignIn={header.onSignIn}
            onSignOut={header.onSignOut}
            menuOpen={header.menuOpen}
          />
        )}
        {banner ? <div className={s.banner}>{banner}</div> : null}
      </div>
      <main className={s.content}>{children}</main>
      {mobile ? (
        <NavBar
          active={active}
          onYou={onYou}
          youOpen={youOpen}
          youSheetId={youSheetId}
          className={s.nav}
        />
      ) : null}
      {overlay ? live ? overlay : <div className={s.overlay}>{overlay}</div> : null}
    </div>
  );
}
