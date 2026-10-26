import { VOICE } from '@flocked/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDED_KEY } from '../onboarding/OnboardingModal';
import { routes } from '../routes';
import { activeTab } from './AppShell';
import { RouteError } from './RouteError';
import { apiFetch, renderApp, setBreakpoint, setOnline, SIGNED_IN } from './testing';

// The sign-in dialog is the sign-in builder's (its own tests); here it only has to open and close.
vi.mock('../auth/SignInDialog', () => ({
  SignInDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div role="dialog" aria-label="Sign in">
        <button type="button" onClick={onClose}>
          Not now
        </button>
      </div>
    ) : null,
}));

beforeEach(() => {
  localStorage.setItem(ONBOARDED_KEY, '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('activeTab', () => {
  it('maps routes to tabs: the You pages to You, profiles and rounds to none', () => {
    expect(activeTab('/')).toBe('today');
    expect(activeTab('/archive')).toBe('archive');
    expect(activeTab('/leaderboards')).toBe('boards');
    expect(activeTab('/rooms')).toBe('rooms');
    expect(activeTab('/rooms/01K6Z8Y4N2R7VQ3M5T9W1XB0CM')).toBe('rooms');
    for (const path of ['/submit', '/queue', '/claims', '/settings']) {
      expect(activeTab(path)).toBe('you');
    }
    expect(activeTab('/u/woolly')).toBeNull();
    expect(activeTab('/r/01K6Z8Y4N2R7VQ3M5T9W1XB0CD')).toBeNull();
    expect(activeTab('/roomsy')).toBeNull();
  });
});

describe('AppShell on mobile', () => {
  it('marks the route’s tab current and shows the screen', async () => {
    renderApp({ path: '/leaderboards' });
    expect(await screen.findByRole('heading', { name: 'Boards' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Boards' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps You current on a You page', async () => {
    renderApp({ path: '/claims' });
    expect(await screen.findByRole('heading', { name: 'Claims' })).toBeVisible();
    // This is the real Claims screen, not the route table's former title-only placeholder.
    expect(screen.getByRole('button', { name: 'Connect a wallet' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'You' })).toHaveAttribute('aria-current', 'page');
  });

  it('follows the tabs', async () => {
    renderApp({ path: '/archive' });
    await userEvent.click(await screen.findByRole('link', { name: 'Rooms' }));
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Rooms' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Archive' })).not.toHaveAttribute('aria-current');
  });

  it('opens the You sheet from the You tab, and a link in it goes there and closes it', async () => {
    renderApp({ path: '/archive' });
    const you = await screen.findByRole('button', { name: 'You' });
    await userEvent.click(you);
    const sheet = screen.getByRole('dialog', { name: 'You' });
    expect(you).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(within(sheet).getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'You' })).toBeNull();
    expect(screen.getByRole('button', { name: 'You' })).toHaveAttribute('aria-current', 'page');
  });

  it('closes the You sheet with Not now', async () => {
    renderApp({ path: '/archive' });
    await userEvent.click(await screen.findByRole('button', { name: 'You' }));
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog', { name: 'You' })).toBeNull();
  });

  it('signed in: the header shows the Free balance and the avatar opens You', async () => {
    renderApp({ path: '/archive', fetch: apiFetch(SIGNED_IN) });
    expect(await screen.findByText('1,240 points')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Your account' }));
    expect(screen.getByRole('dialog', { name: 'You' })).toBeVisible();
  });

  it('signs out from the You sheet', async () => {
    const fetch = apiFetch(SIGNED_IN);
    renderApp({ path: '/archive', fetch });
    await userEvent.click(await screen.findByRole('button', { name: 'Your account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(
      fetch.mock.calls.some(
        ([url, init]) => (url as URL).pathname === '/api/v1/auth/logout' && init?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('opens sign-in from the header', async () => {
    renderApp({ path: '/archive' });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    const dialog = screen.getByRole('dialog', { name: 'Sign in' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull();
  });

  it('shows the offline banner under the header while offline', async () => {
    renderApp({ path: '/archive' });
    await screen.findByRole('heading', { name: 'Archive' });
    expect(screen.queryByText(VOICE.offline)).toBeNull();
    act(() => setOnline(false));
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(VOICE.offline);
    expect(
      banner.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => setOnline(true));
    await waitFor(() => expect(screen.queryByText(VOICE.offline)).toBeNull());
  });
});

describe('AppShell on desktop', () => {
  beforeEach(() => {
    setBreakpoint('desktop');
  });

  it('shows the header links with the route’s tab current and no tab bar', async () => {
    renderApp({ path: '/rooms/01K6Z8Y4N2R7VQ3M5T9W1XB0CM' });
    expect(await screen.findByRole('heading', { name: 'Room' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Rooms' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'You' })).toBeNull();
  });

  it('shows no current link on a You page', async () => {
    renderApp({ path: '/settings' });
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('signed in: the avatar menu lists the You pages and signs out', async () => {
    const fetch = apiFetch(SIGNED_IN);
    renderApp({ path: '/', fetch });
    expect(await screen.findByText('1,240 points')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Submit', 'Queue', 'Claims', 'Settings', 'Sign out']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  it('shows the offline banner under the header', async () => {
    setOnline(false);
    renderApp({ path: '/archive' });
    expect(await screen.findByRole('status')).toHaveTextContent(VOICE.offline);
  });
});

describe('RouteError', () => {
  function Throws(): never {
    throw new Error('boom');
  }

  it('shows the error box with a retry in the screen’s place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createMemoryRouter([
      {
        element: (
          <div>
            <nav aria-label="Main" />
            <Outlet />
          </div>
        ),
        children: [
          { errorElement: <RouteError />, children: [{ index: true, Component: Throws }] },
        ],
      },
    ]);
    render(<RouterProvider router={router} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(VOICE.error);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.queryByRole('main')).toBeNull();
  });

  it('is the whole page when the shell itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createMemoryRouter([
      { path: '/', Component: Throws, errorElement: <RouteError standalone /> },
    ]);
    render(<RouterProvider router={router} />);
    const alert = await screen.findByRole('alert');
    expect(screen.getByRole('main')).toContainElement(alert);
  });

  it('nests in the route table: a failing screen keeps the shell', () => {
    const shell = routes.find((r) => r.errorElement && r.children);
    expect(shell?.children?.[0]?.errorElement).toBeTruthy();
    expect(shell?.children?.[0]?.children?.some((r) => r.index)).toBe(true);
  });
});
