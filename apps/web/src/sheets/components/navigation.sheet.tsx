// Components › Navigation (Paper `components/navigation/{light,dark}/desktop`, sheet 9 of 9): the
// mobile nav bar on each of its five tabs, the tablet/desktop header signed in and signed out, and the
// mobile header. The bars and headers are the real components; the sheet page sits inside the app's
// router, so their links work as they are.
import type { ReactNode } from 'react';
import { TABS } from '../../nav';
import { Header } from '../../ui/Header';
import { MobileHeader } from '../../ui/MobileHeader';
import { NavBar } from '../../ui/NavBar';
import { ComponentSheet, SheetSectionHead } from '../SheetChrome';
import type { SheetDef, SheetTheme } from '../types';
import s from './navigation.module.css';

const noop = () => undefined;
const USER = { handle: 'jay' };
const POINTS = { mode: 'free', points: 640 } as const;

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={s.noteBlock}>
      <p className="type-body-strong">{title}</p>
      <p className={s.note}>{children}</p>
    </div>
  );
}

function NavigationSheet({ theme }: { theme: SheetTheme }) {
  return (
    <ComponentSheet
      theme={theme}
      index={9}
      title="Navigation"
      intro="A bottom tab bar on mobile and a single header row on desktop. Five destinations; everything else (Claims, Settings, Submit, Queue) is one tap from You or the header."
    >
      <section className={s.navBars}>
        <div className={s.bars}>
          <h2 className="type-title">Nav bar (mobile)</h2>
          {TABS.map((tab) => (
            <NavBar key={tab.id} active={tab.id} onYou={noop} />
          ))}
        </div>
        <div className={s.notes}>
          <Note title="Anatomy">
            Five equal slots, 72px plus the device safe area. 22px line icons (2px stroke) with a
            nav label (13/18 Inter 400 ink). A line divider above; the bar is bg, not a floating
            card.
          </Note>
          <Note title="Active">
            An ink pill behind the icon (icon turns bg) and a 600-weight label. Inactive labels stay
            ink at 400, so the active tab never relies on color. The accent never appears here.
          </Note>
          <Note title="Destinations">
            Today, Archive, Boards (Leaderboards), Rooms, You (with Claims and Settings). Submit and
            Queue open from You on mobile and from the avatar menu on desktop. Five is the cap; a
            sixth destination needs a design decision.
          </Note>
        </div>
      </section>
      <section className={s.headers}>
        <SheetSectionHead
          title="Header (desktop)"
          note="From the tablet breakpoint up. Four links: Today, Archive, Boards and Rooms. Submit, Queue, Claims and Settings sit in the avatar menu. The active link uses the tab underline."
        />
        <p className="type-body-strong">Signed in, Today</p>
        <Header
          active="today"
          breakpoint="tablet"
          user={USER}
          balance={POINTS}
          onSignIn={noop}
          onSignOut={noop}
        />
        <div className={s.stateLabel}>
          <p className="type-body-strong">Signed out, Boards</p>
        </div>
        <Header active="boards" breakpoint="tablet" user={null} onSignIn={noop} onSignOut={noop} />
        <div className={s.mobileRow}>
          <div className={s.mobileColumn}>
            <p className="type-body-strong">Header (mobile)</p>
            <MobileHeader user={USER} balance={POINTS} onSignIn={noop} onYou={noop} />
          </div>
          <p className={`${s.note} ${s.mobileNote}`}>
            Wordmark in Fredoka 700, never the accent. The balance slot follows the mode: points in
            Free, and in Stakes the 30-day net result (&quot;30 days: +12 USDC&quot;, Inter 500
            14px, ink), which links to the Stakes history under You. The avatar opens You. Headers
            sit on bg with a line divider and don&apos;t stick on Today, where the question owns the
            top of the screen.
          </p>
        </div>
      </section>
    </ComponentSheet>
  );
}

const sheet: SheetDef = {
  name: 'components/navigation',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <NavigationSheet theme={state === 'dark' ? 'dark' : 'light'} />,
};

export default sheet;
