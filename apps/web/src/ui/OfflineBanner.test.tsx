import { VOICE } from '@flocked/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OfflineBanner } from './OfflineBanner';

describe('OfflineBanner', () => {
  it('is a status message with the offline line', () => {
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent(VOICE.offline);
  });

  it('is not dismissible and keeps its icon decorative', () => {
    render(<OfflineBanner />);
    const banner = screen.getByRole('status');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(banner.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
