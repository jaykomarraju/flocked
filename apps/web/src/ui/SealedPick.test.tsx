import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SealedPick } from './SealedPick';

describe('SealedPick', () => {
  it('shows the picked option and the Free stake, and says it is sealed', () => {
    const { container } = render(
      <SealedPick option="One horse-sized duck" mode="free" stake={25n} />,
    );
    expect(screen.getByText('One horse-sized duck')).toBeInTheDocument();
    expect(screen.getByText('25 points')).toBeInTheDocument();
    // The padlock is decoration; the word carries the meaning.
    expect(screen.getByText('Sealed')).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows a Stakes stake in USDC', () => {
    render(<SealedPick option="Cats" mode="stakes" stake={2_500_000n} />);
    expect(screen.getByText('2.50 USDC')).toBeInTheDocument();
  });

  it('is a display, not a control', () => {
    render(<SealedPick option="Cats" mode="free" stake={10n} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
