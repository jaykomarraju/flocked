import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SealedBadge } from './SealedBadge';

describe('SealedBadge', () => {
  it('reads "Sealed", with the padlock hidden from assistive tech', () => {
    const { container } = render(<SealedBadge />);
    expect(screen.getByText('Sealed')).toBeInTheDocument();
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
