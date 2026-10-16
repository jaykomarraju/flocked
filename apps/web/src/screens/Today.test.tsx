import { VOICE } from '@flocked/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../test/fixtures';
import { ONBOARDED_KEY } from '../onboarding/OnboardingModal';
import { apiFetch, renderApp, SIGNED_IN, TODAY } from '../layout/testing';
import { formatGameDay } from './Today';

vi.mock('../auth/SignInDialog', () => ({
  SignInDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Sign in" /> : null,
}));

const round = TODAY.round!;
const withRound = { 'GET /rounds/today': () => json(200, TODAY) };

beforeEach(() => {
  localStorage.setItem(ONBOARDED_KEY, '1');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('formatGameDay', () => {
  it('reads a game day as the date line', () => {
    expect(formatGameDay('2026-10-08')).toBe('Thursday, Oct 8');
    expect(formatGameDay('2027-01-01')).toBe('Friday, Jan 1');
  });
});

describe('Today', () => {
  it('shows the skeleton while the round loads', async () => {
    renderApp({ fetch: apiFetch({ 'GET /rounds/today': () => new Promise<Response>(() => {}) }) });
    expect(await screen.findByText('Loading')).toBeInTheDocument();
    expect(screen.getByText('Loading').closest('[aria-busy="true"]')).not.toBeNull();
  });

  it('shows the error box, and Retry asks again', async () => {
    let calls = 0;
    const fetch = apiFetch({
      'GET /rounds/today': () =>
        ++calls === 1
          ? json(500, { error: { code: 'internal', message: 'Internal error' } })
          : json(200, TODAY),
    });
    renderApp({ fetch });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(VOICE.error);
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: round.question.prompt })).toBeVisible();
    expect(calls).toBe(2);
  });

  it('shows the empty state when there is no round', async () => {
    renderApp();
    expect(await screen.findByText(VOICE.emptyState)).toBeVisible();
  });

  it('signed out: the round, the counter, and "Sign in to play" opens sign-in', async () => {
    renderApp({ fetch: apiFetch(withRound) });
    const question = await screen.findByRole('heading', { level: 1, name: 'Pineapple on pizza?' });
    expect(question).toBeVisible();
    expect(screen.getByText('Thursday, Oct 8')).toBeVisible();
    const options = screen.getByRole('radiogroup', { name: 'Pineapple on pizza?' });
    expect(
      within(options)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['🍍 Pineapple', 'No pineapple']);
    expect(screen.getByRole('timer', { name: 'Closes in' })).toBeVisible();
    expect(screen.getByText('153 in · 8,150 points')).toBeVisible();
    expect(screen.getByText('Free to play. Points have no cash value.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to play' }));
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeVisible();
  });

  it('switches the counter with the mode', async () => {
    renderApp({ fetch: apiFetch(withRound) });
    await userEvent.click(await screen.findByRole('radio', { name: 'Stakes' }));
    expect(screen.getByText('37 in · 185 USDC')).toBeVisible();
    expect(screen.queryByText('Free to play. Points have no cash value.')).toBeNull();
  });

  it('signed in: "Seal my pick" stays disabled, before and after a pick (no entry flow yet)', async () => {
    renderApp({ fetch: apiFetch({ ...SIGNED_IN, ...withRound }) });
    const seal = await screen.findByRole('button', { name: 'Seal my pick' });
    expect(seal).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'No pineapple' }));
    expect(screen.getByRole('radio', { name: 'No pineapple' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(seal).toBeDisabled();
  });

  it('counts down to close', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((round.closesAt - 3600) * 1000);
    renderApp({ fetch: apiFetch(withRound) });
    const timer = await screen.findByRole('timer', { name: 'Closes in' });
    expect(timer).toHaveTextContent('01:00:00');
    vi.setSystemTime((round.closesAt - 3599) * 1000);
    await waitFor(() => expect(timer).toHaveTextContent('00:59:59'), { timeout: 2500 });
  });
});
