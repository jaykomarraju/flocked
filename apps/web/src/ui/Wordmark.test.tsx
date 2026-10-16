import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Wordmark } from './Wordmark';

describe('Wordmark', () => {
  it.each(['mobile', 'desktop'] as const)('is a named link home (%s)', (size) => {
    render(
      <MemoryRouter>
        <Wordmark size={size} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Flocked home' });
    expect(link).toHaveAttribute('href', '/');
    expect(link).toHaveTextContent('Flocked');
  });
});
