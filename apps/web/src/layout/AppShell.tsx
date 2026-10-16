// The live shell (spec "Client app" › Navigation; docs/design/README.md "Screen conventions (Core
// flow)"): the screen frame at the current breakpoint with the session's header (the Free points
// balance once signed in), the active tab from the route, the offline banner under the header, and
// the shell's dialogs: the You sheet (mobile; the avatar menu does its job from tablet up), sign-in
// and the first-visit onboarding.
import { useEffect, useId, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/session';
import { SignInDialog } from '../auth/SignInDialog';
import { useOnline } from '../lib/online';
import type { TabId } from '../nav';
import { Onboarding } from '../onboarding/OnboardingModal';
import { useBreakpoint } from '../theme';
import type { Balance } from '../ui/BalanceSlot';
import type { HeaderUser } from '../ui/Header';
import { OfflineBanner } from '../ui/OfflineBanner';
import { YouSheet } from '../ui/YouSheet';
import { ShellFrame } from './ShellFrame';
import { SignInProvider, useSignIn } from './SignInContext';

/** The You pages: reached from the You sheet (mobile) or the avatar menu (tablet and desktop). */
const YOU_PAGES = ['/submit', '/queue', '/claims', '/settings'];

const under = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

/**
 * The tab a route belongs to: Today, Archive, Boards, Rooms, or You for the You pages (the header
 * shows no active link for those). Profiles, rounds and unknown pages belong to none.
 */
export function activeTab(pathname: string): TabId | null {
  if (pathname === '/' || pathname === '') return 'today';
  if (under(pathname, '/archive')) return 'archive';
  if (under(pathname, '/leaderboards')) return 'boards';
  if (under(pathname, '/rooms')) return 'rooms';
  if (YOU_PAGES.some((p) => under(pathname, p))) return 'you';
  return null;
}

export function AppShell() {
  return (
    <SignInProvider>
      <Shell />
    </SignInProvider>
  );
}

function Shell() {
  const breakpoint = useBreakpoint();
  const { status, me, signOut } = useAuth();
  const signIn = useSignIn();
  const online = useOnline();
  const { pathname } = useLocation();
  const [youOpen, setYouOpen] = useState(false);
  const youSheetId = useId();
  const mobile = breakpoint === 'mobile';

  // The You sheet belongs to mobile and to the page it opened on.
  useEffect(() => {
    setYouOpen(false);
  }, [pathname, mobile]);

  const account = status === 'signed-in' ? me : null;
  const user: HeaderUser | null = account
    ? {
        handle: account.user.handle ?? account.user.displayName ?? '',
        avatarUrl: account.user.avatarUrl,
      }
    : null;
  const balance: Balance | null = account
    ? { mode: 'free', points: BigInt(account.balances.global) }
    : null;
  // Sign-out always drops the session locally; a failed logout call leaves nothing to show.
  const onSignOut = () => {
    signOut().catch(() => undefined);
  };

  return (
    <ShellFrame
      breakpoint={breakpoint}
      header={{ user, balance, onSignIn: signIn.open, onSignOut }}
      active={activeTab(pathname)}
      onYou={() => setYouOpen((open) => !open)}
      youOpen={mobile && youOpen}
      youSheetId={youSheetId}
      banner={online ? null : <OfflineBanner />}
      overlay={
        <>
          {mobile ? (
            <YouSheet
              id={youSheetId}
              open={youOpen}
              onClose={() => setYouOpen(false)}
              onSignOut={status === 'signed-in' ? onSignOut : undefined}
            />
          ) : null}
          <SignInDialog open={signIn.isOpen} onClose={signIn.close} />
          <Onboarding />
        </>
      }
    >
      <Outlet />
    </ShellFrame>
  );
}
