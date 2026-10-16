import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Breakpoint } from '../theme';
import { OfflineBanner } from '../ui/OfflineBanner';
import { ShellFrame, type ShellFrameProps } from './ShellFrame';

function renderFrame(breakpoint: Breakpoint, props: Partial<ShellFrameProps> = {}) {
  const onSignIn = vi.fn();
  const onSignOut = vi.fn();
  const onYou = vi.fn();
  render(
    <MemoryRouter>
      <ShellFrame
        breakpoint={breakpoint}
        header={{ user: null, onSignIn, onSignOut }}
        active="today"
        onYou={onYou}
        {...props}
      >
        <h1>Screen</h1>
      </ShellFrame>
    </MemoryRouter>,
  );
  return { onSignIn, onSignOut, onYou };
}

describe('ShellFrame', () => {
  it('on mobile: the header, the screen in main, and the five tabs with the active one current', () => {
    renderFrame('mobile', { active: 'archive' });
    expect(within(screen.getByRole('main')).getByRole('heading', { name: 'Screen' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(5);
    expect(within(nav).getByRole('link', { name: 'Archive' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Today' })).not.toHaveAttribute('aria-current');
  });

  it('on mobile: "Sign in" and the You tab call back; the You tab says whether the sheet is open', async () => {
    const { onSignIn, onYou } = renderFrame('mobile', { youOpen: true, youSheetId: 'you' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalledOnce();
    const you = screen.getByRole('button', { name: 'You' });
    expect(you).toHaveAttribute('aria-expanded', 'true');
    expect(you).toHaveAttribute('aria-controls', 'you');
    await userEvent.click(you);
    expect(onYou).toHaveBeenCalledOnce();
  });

  it('on mobile: You is current on the You pages', () => {
    renderFrame('mobile', { active: 'you' });
    expect(screen.getByRole('button', { name: 'You' })).toHaveAttribute('aria-current', 'page');
  });

  it('from tablet up: the header links, no tab bar, and no current link on a You page', () => {
    renderFrame('desktop', { active: 'you' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Today', 'Archive', 'Boards', 'Rooms']);
    expect(within(nav).queryByRole('link', { current: 'page' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'You' })).toBeNull();
  });

  it('from tablet up: the active tab is the current link; signed in, the balance and the avatar menu', () => {
    renderFrame('tablet', {
      active: 'boards',
      header: {
        user: { handle: 'woolly' },
        balance: { mode: 'free', points: 1240n },
        onSignIn: vi.fn(),
        onSignOut: vi.fn(),
      },
    });
    expect(screen.getByRole('link', { name: 'Boards' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('1,240 points')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('puts the banner between the header and the screen', () => {
    renderFrame('mobile', { banner: <OfflineBanner /> });
    const banner = screen.getByRole('status');
    const main = screen.getByRole('main');
    expect(banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner).toHaveTextContent("You're offline. Nothing can be sealed until you're back.");
  });

  it('draws an artboard: the overlay inside the frame, the fixed height on the frame', () => {
    renderFrame('mobile', {
      artboard: { height: 844 },
      overlay: <div role="dialog" aria-label="Over" />,
    });
    const dialog = screen.getByRole('dialog', { name: 'Over' });
    const frame = screen.getByRole('main').parentElement!;
    expect(frame).toContainElement(dialog);
    expect(frame.style.height).toBe('844px');
  });
});
