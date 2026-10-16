import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { TabId } from '../nav';
import { Header, type HeaderProps } from './Header';

function renderHeader(props: Partial<HeaderProps> = {}) {
  const onSignIn = vi.fn();
  const onSignOut = vi.fn();
  render(
    <MemoryRouter>
      <Header
        active="today"
        breakpoint="desktop"
        user={{ handle: 'jay' }}
        balance={{ mode: 'free', points: 640 }}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onSignIn, onSignOut, header: screen.getByRole('banner') };
}

describe('Header', () => {
  it('has the wordmark home and the four route links, never the You links', () => {
    const { header } = renderHeader();
    expect(within(header).getByRole('link', { name: 'Flocked home' })).toHaveAttribute('href', '/');
    const nav = within(header).getByRole('navigation', { name: 'Main' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Today', 'Archive', 'Boards', 'Rooms']);
    for (const name of ['Submit', 'Queue', 'Claims', 'Settings', 'You']) {
      expect(within(header).queryByRole('link', { name })).not.toBeInTheDocument();
    }
  });

  it.each([
    ['today', 'Today'],
    ['archive', 'Archive'],
    ['boards', 'Boards'],
    ['rooms', 'Rooms'],
  ] as const)('marks %s as the current page', (active, name) => {
    const { header } = renderHeader({ active });
    const nav = within(header).getByRole('navigation', { name: 'Main' });
    const current = within(nav)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual([name]);
  });

  it.each<TabId | null>(['you', null])('shows no active link for %s', (active) => {
    const { header } = renderHeader({ active });
    expect(header.querySelector('[aria-current]')).toBeNull();
  });

  it('signed in: the points balance and the avatar menu', () => {
    const { header } = renderHeader();
    expect(within(header).getByText('640 points')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Account menu' })).toHaveAttribute(
      'aria-haspopup',
      'menu',
    );
    expect(within(header).queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('in Stakes: the 30-day net, linked to the Stakes history', () => {
    const { header } = renderHeader({
      breakpoint: 'tablet',
      balance: { mode: 'stakes', net: 12_000_000n, href: '/claims' },
    });
    expect(within(header).getByRole('link', { name: '30 days: +12 USDC' })).toHaveAttribute(
      'href',
      '/claims',
    );
  });

  it('signed out: the Sign in pill instead of the balance and avatar', async () => {
    const user = userEvent.setup();
    const { header, onSignIn } = renderHeader({ user: null, active: 'boards' });
    expect(within(header).queryByText(/points/)).not.toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
    await user.click(within(header).getByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('signs out from the avatar menu', async () => {
    const user = userEvent.setup();
    const { header, onSignOut } = renderHeader();
    await user.click(within(header).getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
