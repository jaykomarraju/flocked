import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { TABS, type TabId } from '../nav';
import { NavBar } from './NavBar';

function renderBar(active: TabId | null, props: { youOpen?: boolean; onYou?: () => void } = {}) {
  const onYou = props.onYou ?? vi.fn();
  render(
    <MemoryRouter>
      <NavBar active={active} onYou={onYou} youOpen={props.youOpen} youSheetId="you-sheet" />
    </MemoryRouter>,
  );
  return { onYou, nav: screen.getByRole('navigation', { name: 'Main' }) };
}

describe('NavBar', () => {
  it('lists the five tabs in order: four links and the You button', () => {
    const { nav } = renderBar('today');
    const items = within(nav).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Today',
      'Archive',
      'Boards',
      'Rooms',
      'You',
    ]);
    expect(within(nav).getByRole('link', { name: 'Today' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Archive' })).toHaveAttribute('href', '/archive');
    expect(within(nav).getByRole('link', { name: 'Boards' })).toHaveAttribute(
      'href',
      '/leaderboards',
    );
    expect(within(nav).getByRole('link', { name: 'Rooms' })).toHaveAttribute('href', '/rooms');
    expect(within(nav).getByRole('button', { name: 'You' })).toBeInTheDocument();
  });

  it.each(['today', 'archive', 'boards', 'rooms'] as const)(
    'marks only the active tab (%s) as the current page',
    (tab) => {
      const { nav } = renderBar(tab);
      const current = within(nav)
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveAttribute('href', TABS.find((t) => t.id === tab)?.path);
      expect(within(nav).getByRole('button', { name: 'You' })).not.toHaveAttribute('aria-current');
    },
  );

  it('keeps You current on pages reached from You', () => {
    const { nav } = renderBar('you');
    expect(within(nav).getByRole('button', { name: 'You' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const link of within(nav).getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('marks nothing current when the page has no tab', () => {
    const { nav } = renderBar(null);
    expect(nav.querySelector('[aria-current]')).toBeNull();
  });

  it('toggles the You sheet from the You button', async () => {
    const user = userEvent.setup();
    const { onYou, nav } = renderBar('today');
    const you = within(nav).getByRole('button', { name: 'You' });
    expect(you).toHaveAttribute('aria-haspopup', 'dialog');
    expect(you).toHaveAttribute('aria-expanded', 'false');
    expect(you).not.toHaveAttribute('aria-controls');
    await user.click(you);
    expect(onYou).toHaveBeenCalledTimes(1);
  });

  it('reports the open You sheet', () => {
    const { nav } = renderBar('you', { youOpen: true });
    const you = within(nav).getByRole('button', { name: 'You' });
    expect(you).toHaveAttribute('aria-expanded', 'true');
    expect(you).toHaveAttribute('aria-controls', 'you-sheet');
  });

  it('reaches every tab with the keyboard', async () => {
    const user = userEvent.setup();
    const { onYou } = renderBar('today');
    for (const name of ['Today', 'Archive', 'Boards', 'Rooms']) {
      await user.tab();
      expect(screen.getByRole('link', { name })).toHaveFocus();
    }
    await user.tab();
    expect(screen.getByRole('button', { name: 'You' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onYou).toHaveBeenCalledTimes(1);
  });
});
