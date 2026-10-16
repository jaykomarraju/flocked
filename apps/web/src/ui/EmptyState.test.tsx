import { VOICE } from '@flocked/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('shows the empty-state voice line by default, with a decorative neutral sheep', () => {
    const { container } = render(<EmptyState />);
    expect(screen.getByText(VOICE.emptyState)).toBeInTheDocument();
    const sheep = container.querySelector('svg[data-pose]');
    expect(sheep).toHaveAttribute('data-pose', 'neutral');
    expect(sheep).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes a list line and one way out', () => {
    render(<EmptyState line="No rounds yet." action={<a href="/archive">See past rounds</a>} />);
    expect(screen.getByText('No rounds yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See past rounds' })).toHaveAttribute(
      'href',
      '/archive',
    );
  });

  it('has no action unless given one', () => {
    render(<EmptyState />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
