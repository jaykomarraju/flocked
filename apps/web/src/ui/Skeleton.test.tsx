import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKELETON_DELAY_MS, Skeleton } from './Skeleton';

describe('Skeleton', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing for the first 300ms, so fast loads never flash it', () => {
    vi.useFakeTimers();
    render(<Skeleton />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS - 1);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('is busy and announces one label, with the blocks hidden', () => {
    const { container } = render(<Skeleton delay={0} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading');
    const region = container.firstElementChild;
    expect(region).toHaveAttribute('aria-busy', 'true');
    const blocks = [...(region?.children ?? [])].filter((el) => el !== status);
    expect(blocks).toHaveLength(5);
    for (const block of blocks) expect(block).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes another label', () => {
    render(<Skeleton delay={0} label="Loading the archive" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the archive');
  });
});
