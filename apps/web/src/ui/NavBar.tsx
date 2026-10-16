// The mobile tab bar (Paper Components › Navigation › "Nav bar (mobile)"; spec "Client app" ›
// Navigation): five equal slots, Today, Archive, Boards and Rooms as links and You as a button that
// toggles the You sheet. The active tab gets an ink pill behind its icon and a 600-weight label, so it
// never relies on colour. Pages reached from You keep You active.
import type { ComponentType, SVGProps } from 'react';
import { Link } from 'react-router';
import { TABS, type TabId } from '../nav';
import { ArchiveIcon } from './icons/ArchiveIcon';
import { BoardsIcon } from './icons/BoardsIcon';
import { RoomsIcon } from './icons/RoomsIcon';
import { TodayIcon } from './icons/TodayIcon';
import { YouIcon } from './icons/YouIcon';
import s from './NavBar.module.css';

const ICONS: Record<TabId, ComponentType<SVGProps<SVGSVGElement>>> = {
  today: TodayIcon,
  archive: ArchiveIcon,
  boards: BoardsIcon,
  rooms: RoomsIcon,
  you: YouIcon,
};

export interface NavBarProps {
  /** The active tab, or null when the page belongs to none (a profile, a round). */
  active: TabId | null;
  /** The You tab: toggles the You sheet. */
  onYou: () => void;
  /** Whether the You sheet is open (the You button's `aria-expanded`). */
  youOpen?: boolean;
  /** The You sheet's id, for the You button's `aria-controls` while it is open. */
  youSheetId?: string;
  className?: string;
}

export function NavBar({ active, onYou, youOpen = false, youSheetId, className }: NavBarProps) {
  return (
    <nav aria-label="Main" className={className ? `${s.bar} ${className}` : s.bar}>
      <ul className={s.slots}>
        {TABS.map((tab) => {
          const Icon = ICONS[tab.id];
          const isActive = tab.id === active;
          const body = (
            <>
              <span className={s.indicator} aria-hidden="true">
                <Icon />
              </span>
              <span className={s.label}>{tab.label}</span>
            </>
          );
          return (
            <li key={tab.id} className={s.slot}>
              {tab.path === null ? (
                <button
                  type="button"
                  className={s.item}
                  data-active={isActive || undefined}
                  aria-current={isActive ? 'page' : undefined}
                  aria-haspopup="dialog"
                  aria-expanded={youOpen}
                  aria-controls={youOpen ? youSheetId : undefined}
                  onClick={onYou}
                >
                  {body}
                </button>
              ) : (
                <Link
                  to={tab.path}
                  className={s.item}
                  data-active={isActive || undefined}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
