import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { MobileHeader, type MobileHeaderProps } from './MobileHeader';

function renderHeader(props: Partial<MobileHeaderProps> = {}) {
  const onSignIn = vi.fn();
  const onYou = vi.fn();
  render(
    <MemoryRouter>
      <MobileHeader
        user={{ handle: 'jay' }}
        balance={{ mode: 'free', points: 640 }}
        onSignIn={onSignIn}
        onYou={onYou}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onSignIn, onYou, header: screen.getByRole('banner') };
}

describe('MobileHeader', () => {
  it('has the wordmark home, the balance and the avatar, which opens You', async () => {
    const user = userEvent.setup();
    const { header, onYou } = renderHeader();
    expect(within(header).getByRole('link', { name: 'Flocked home' })).toHaveAttribute('href', '/');
    expect(within(header).getByText('640 points')).toBeInTheDocument();
    const avatar = within(header).getByRole('button', { name: 'Your account' });
    expect(avatar).toHaveAttribute('aria-haspopup', 'dialog');
    expect(avatar).toHaveAttribute('aria-expanded', 'false');
    await user.click(avatar);
    expect(onYou).toHaveBeenCalledTimes(1);
  });

  it('reports the open You sheet on the avatar', () => {
    const { header } = renderHeader({ youOpen: true });
    expect(within(header).getByRole('button', { name: 'Your account' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('shows the Stakes net in the balance slot', () => {
    const { header } = renderHeader({ balance: { mode: 'stakes', net: -3_500_000n } });
    expect(within(header).getByText('30 days: -3.50 USDC')).toBeInTheDocument();
  });

  it('signed out: the Sign in pill only', async () => {
    const user = userEvent.setup();
    const { header, onSignIn } = renderHeader({ user: null });
    expect(within(header).queryByText(/points/)).not.toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: 'Your account' })).not.toBeInTheDocument();
    await user.click(within(header).getByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});
