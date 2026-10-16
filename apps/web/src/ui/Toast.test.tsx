import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOAST_DURATION_MS, Toast } from './Toast';

describe('Toast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a polite status message', () => {
    render(<Toast message="Reminder set for 8:55pm." />);
    expect(screen.getByRole('status')).toHaveTextContent('Reminder set for 8:55pm.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('runs its action from a real button, by click and by keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Toast message="Reminder set for 8:55pm." action={{ label: 'Undo', onClick }} />);
    const undo = screen.getByRole('button', { name: 'Undo' });
    await user.click(undo);
    await user.tab();
    await user.tab({ shift: true });
    expect(undo).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('leaves after 4 seconds', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Back online." onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('restarts the clock when a new message replaces the old', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(<Toast message="First." onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    rerender(<Toast message="Second." onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
