import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, renderApp, SIGNED_IN } from '../layout/testing';
import { ONBOARDED_KEY, OnboardingModal } from './OnboardingModal';

vi.mock('../auth/SignInDialog', () => ({
  SignInDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Sign in" /> : null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const CARD_1 = 'Pick the side fewer people pick';
const CARD_2 = 'Picks stay sealed until just after 9pm ET';
const CARD_3 = 'The Flock loses. Strays win.';

function renderModal(initialCard?: number) {
  const onClose = vi.fn();
  const onSignIn = vi.fn();
  render(<OnboardingModal open onClose={onClose} onSignIn={onSignIn} initialCard={initialCard} />);
  return { onClose, onSignIn };
}

describe('OnboardingModal', () => {
  it('is a modal dialog named by its card, with its place, the close button and Next', () => {
    renderModal();
    const dialog = screen.getByRole('dialog', { name: CARD_1 });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByText('1 of 3')).toBeVisible();
    expect(
      within(dialog).getByText(
        'One question a day, two answers. When the picks unseal, the smaller side wins.',
      ),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeVisible();
  });

  it('pages with Next, to "Sign in to play" on the last card', async () => {
    const { onSignIn } = renderModal();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: CARD_2 })).toBeVisible();
    expect(screen.getByText('2 of 3')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: CARD_3 })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to play' }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it('pages with the arrow keys, and stops at the ends', async () => {
    renderModal();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: CARD_1 })).toBeVisible();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: CARD_2 })).toBeVisible();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('dialog', { name: CARD_3 })).toBeVisible();
    expect(screen.getByText('3 of 3')).toBeVisible();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: CARD_2 })).toBeVisible();
  });

  it('keeps focus inside and closes with Escape or the close button', async () => {
    const { onClose } = renderModal(2);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Sign in to play' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Onboarding in the app', () => {
  it('opens on a signed-out first visit; closing it sets the flag and it stays closed', async () => {
    const first = renderApp();
    expect(await screen.findByRole('dialog', { name: CARD_1 })).toBeVisible();
    expect(localStorage.getItem(ONBOARDED_KEY)).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: CARD_1 })).toBeNull();
    expect(localStorage.getItem(ONBOARDED_KEY)).toBe('1');
    first.unmount();
    renderApp();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Sign in to play" closes it, sets the flag and opens sign-in', async () => {
    renderApp();
    await screen.findByRole('dialog', { name: CARD_1 });
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to play' }));
    expect(screen.queryByRole('dialog', { name: CARD_3 })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeVisible();
    expect(localStorage.getItem(ONBOARDED_KEY)).toBe('1');
  });

  it('doesn’t open for a visitor who has the flag', async () => {
    localStorage.setItem(ONBOARDED_KEY, '1');
    renderApp();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('doesn’t open for a signed-in visitor, and remembers them', async () => {
    renderApp({ fetch: apiFetch(SIGNED_IN) });
    expect(await screen.findByText('1,240 points')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem(ONBOARDED_KEY)).toBe('1');
  });
});
