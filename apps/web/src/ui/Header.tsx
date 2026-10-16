// The tablet and desktop header (Paper Components › Navigation › "Header (desktop)"; spec "Client
// app" › Navigation): the wordmark, the four route links (Today, Archive, Boards, Rooms) with the tab
// underline on the active one, then the balance slot and the avatar menu, or the "Sign in" pill when
// signed out. Submit, Queue, Claims and Settings live in the avatar menu, never as links here, and
// pages reached from them show no active link. 24px side padding on tablet, 64 on desktop; with the
// 30-day Stakes net in the slot, the tablet header tightens its gaps so the links never shrink
// (docs/design/README.md "Screen conventions (Core flow)").
import { Link } from 'react-router';
import { TABS, type TabId } from '../nav';
import { AvatarMenu } from './AvatarMenu';
import { BalanceSlot, type Balance } from './BalanceSlot';
import { Button } from './Button';
import { Wordmark } from './Wordmark';
import s from './Header.module.css';

export interface HeaderUser {
  handle: string;
  avatarUrl?: string | null;
}

export interface HeaderProps {
  /** The active tab; `you` and null show no active link. */
  active: TabId | null;
  breakpoint: 'tablet' | 'desktop';
  /** The signed-in account, or null for the "Sign in" pill. */
  user: HeaderUser | null;
  /** The balance slot (signed in only). */
  balance?: Balance | null;
  onSignIn: () => void;
  onSignOut: () => void;
  /** Starts with the avatar menu open (design sheets). */
  menuOpen?: boolean;
}

export function Header({
  active,
  breakpoint,
  user,
  balance,
  onSignIn,
  onSignOut,
  menuOpen,
}: HeaderProps) {
  const tight = breakpoint === 'tablet' && balance?.mode === 'stakes';
  return (
    <header className={s.header} data-breakpoint={breakpoint} data-tight={tight || undefined}>
      <Wordmark size="desktop" />
      <nav aria-label="Main" className={s.nav}>
        <ul className={s.links}>
          {TABS.map((tab) =>
            tab.path === null ? null : (
              <li key={tab.id} className={s.slot}>
                <Link
                  to={tab.path}
                  className={`${tab.id === active ? 'type-body-strong' : 'type-body'} ${s.link}`}
                  data-active={tab.id === active || undefined}
                  aria-current={tab.id === active ? 'page' : undefined}
                >
                  {tab.label}
                </Link>
              </li>
            ),
          )}
        </ul>
      </nav>
      {user ? (
        <div className={s.account}>
          {balance ? <BalanceSlot balance={balance} size="desktop" /> : null}
          <AvatarMenu
            handle={user.handle}
            avatarUrl={user.avatarUrl}
            onSignOut={onSignOut}
            defaultOpen={menuOpen}
          />
        </div>
      ) : (
        <Button variant="secondary" size="small" onClick={onSignIn}>
          Sign in
        </Button>
      )}
    </header>
  );
}
