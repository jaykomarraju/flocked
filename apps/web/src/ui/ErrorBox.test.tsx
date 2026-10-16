import { VOICE } from '@flocked/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBox } from './ErrorBox';

describe('ErrorBox', () => {
  it('alerts with the unexpected-error line and a retry button', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorBox onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(VOICE.error);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says what happened and offers no retry for a known cause', () => {
    render(<ErrorBox message={VOICE.entryClosed} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      "This round just closed. Your pick wasn't sent.",
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('marks the error by an icon, kept out of the accessibility tree', () => {
    render(<ErrorBox />);
    const icon = screen.getByRole('alert').querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('retries from the keyboard', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorBox onRetry={onRetry} retryLabel="Try again" />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
