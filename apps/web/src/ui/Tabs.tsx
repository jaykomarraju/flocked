// Tabs (Paper Components › Actions › Tabs): Leaderboards (Strays today, Streaks, Weekly, Creators)
// and Profile. A WAI-ARIA tablist: the active tab is bodyStrong with a 3px ink underline, the rest body
// weight and still ink, so weight and the underline mark it, not colour; hover draws a 3px line
// underline. 44px tap height. One tab stop (the active tab); arrow keys, Home and End move focus and
// select (automatic activation). The screen renders the active panel with `tabPanelProps`. On mobile
// the row scrolls sideways and never wraps.
import { useRef, type KeyboardEvent } from 'react';
import s from './Tabs.module.css';

/** A state the design sheets draw statically; real interaction uses the pseudo-classes. */
export type TabForceState = 'hover' | 'focus';

export interface TabItem {
  id: string;
  label: string;
  forceState?: TabForceState;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  /** The active tab's id. */
  value: string;
  onChange: (id: string) => void;
  /** The tablist's accessible name, e.g. "Leaderboards". */
  label: string;
  /** Prefix for the tab and panel ids (unique on the page). */
  idPrefix: string;
  className?: string;
}

export function tabId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}

export function tabPanelId(idPrefix: string, id: string): string {
  return `${idPrefix}-panel-${id}`;
}

/** Props for the active tab's panel: `<div {...tabPanelProps('boards', value)}>`. */
export function tabPanelProps(idPrefix: string, id: string) {
  return {
    role: 'tabpanel',
    id: tabPanelId(idPrefix, id),
    'aria-labelledby': tabId(idPrefix, id),
    tabIndex: 0,
  } as const;
}

export function Tabs({ tabs, value, onChange, label, idPrefix, className }: TabsProps) {
  const ref = useRef<HTMLDivElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const current = Math.max(
      0,
      tabs.findIndex((t) => t.id === value),
    );
    const last = tabs.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? current === last
          ? 0
          : current + 1
        : e.key === 'ArrowLeft'
          ? current === 0
            ? last
            : current - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    const tab = next === null ? undefined : tabs[next];
    if (next === null || !tab) return;
    e.preventDefault();
    if (tab.id !== value) onChange(tab.id);
    ref.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div className={[s.rule, className].filter(Boolean).join(' ')}>
      <div ref={ref} role="tablist" aria-label={label} className={s.tabs} onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={tabId(idPrefix, t.id)}
              aria-selected={active}
              aria-controls={active ? tabPanelId(idPrefix, t.id) : undefined}
              tabIndex={active ? 0 : -1}
              data-force={t.forceState}
              className={`${active ? 'type-body-strong' : 'type-body'} ${s.tab}`}
              onClick={() => {
                if (!active) onChange(t.id);
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
