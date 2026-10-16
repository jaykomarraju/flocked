import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { YouSheet } from './YouSheet';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderSheet(open = true) {
  const onClose = vi.fn();
  const onSignOut = vi.fn();
  render(
    <MemoryRouter>
      <YouSheet open={open} onClose={onClose} onSignOut={onSignOut} id="you-sheet" />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose, onSignOut };
}

describe('YouSheet', () => {
  it('renders nothing while closed', () => {
    renderSheet(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a dialog named You with the You links and Sign out', () => {
    renderSheet();
    const dialog = screen.getByRole('dialog', { name: 'You' });
    const nav = within(dialog).getByRole('navigation', { name: 'You' });
    expect(nav).toHaveAttribute('id', 'you-sheet');
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Submit', '/submit'],
      ['Queue', '/queue'],
      ['Claims', '/claims'],
      ['Settings', '/settings'],
    ]);
    expect(within(nav).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('closes when a destination is chosen', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();
    await user.click(screen.getByRole('link', { name: 'Queue' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/queue');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and on Not now', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('signs out', async () => {
    const user = userEvent.setup();
    const { onClose, onSignOut } = renderSheet();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
