import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AvatarMenu } from './AvatarMenu';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderMenu(onSignOut = vi.fn()) {
  render(
    <MemoryRouter>
      <AvatarMenu handle="jay" onSignOut={onSignOut} />
      <button type="button">Elsewhere</button>
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  return { onSignOut, button: screen.getByRole('button', { name: 'Account menu' }) };
}

const ITEMS = ['Submit', 'Queue', 'Claims', 'Settings', 'Sign out'];

describe('AvatarMenu', () => {
  it('is a closed menu button showing the avatar initial', () => {
    const { button } = renderMenu();
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveTextContent('J');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on click with the You links and Sign out, focus on the first', async () => {
    const user = userEvent.setup();
    const { button } = renderMenu();
    await user.click(button);
    const menu = screen.getByRole('menu', { name: 'Account menu' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', menu.id);
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(ITEMS);
    expect(screen.getByRole('menuitem', { name: 'Claims' })).toHaveAttribute('href', '/claims');
    expect(screen.getByRole('menuitem', { name: 'Submit' })).toHaveFocus();
  });

  it('opens from the keyboard: Enter and ArrowDown on the first item, ArrowUp on the last', async () => {
    const user = userEvent.setup();
    const { button } = renderMenu();
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: 'Submit' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Submit' })).toHaveFocus();
  });

  it('moves with the arrows (wrapping), Home and End', async () => {
    const user = userEvent.setup();
    const { button } = renderMenu();
    await user.click(button);
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Queue' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Submit' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Submit' })).toHaveFocus();
  });

  it('closes on Escape and returns focus to the avatar', async () => {
    const user = userEvent.setup();
    const { button } = renderMenu();
    await user.click(button);
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });

  it('closes on Tab, on a press outside and on a second click', async () => {
    const user = userEvent.setup();
    const { button } = renderMenu();
    await user.click(button);
    await user.tab();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(button);
    await user.click(button);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('navigates to a link and closes', async () => {
    const user = userEvent.setup();
    const { button } = renderMenu();
    await user.click(button);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/claims');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('signs out from the last item', async () => {
    const user = userEvent.setup();
    const { button, onSignOut } = renderMenu();
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
