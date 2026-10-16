import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EntrantCounter } from './EntrantCounter';

describe('EntrantCounter', () => {
  it('counts entrants and the points pool in Free', () => {
    render(<EntrantCounter mode="free" entrants={1204} pool={30_100n} live />);
    expect(screen.getByText('1,204 in · 30,100 points')).toBeInTheDocument();
  });

  it('counts entrants and the USDC pool (base units) in Stakes', () => {
    render(<EntrantCounter mode="stakes" entrants={212} pool={1_060_000_000n} live />);
    expect(screen.getByText('212 in · 1,060 USDC')).toBeInTheDocument();
  });

  it('shows cents only when the pool has them', () => {
    render(<EntrantCounter mode="stakes" entrants={3} pool={7_500_000n} live />);
    expect(screen.getByText('3 in · 7.50 USDC')).toBeInTheDocument();
  });

  it('marks a live value with the dot while entries are open', () => {
    render(<EntrantCounter mode="free" entrants={1} pool={10n} live />);
    expect(screen.getByRole('img', { name: 'Live' })).toBeInTheDocument();
  });

  it('drops the dot once entries close', () => {
    render(<EntrantCounter mode="free" entrants={1} pool={10n} live={false} />);
    expect(screen.queryByRole('img', { name: 'Live' })).not.toBeInTheDocument();
    expect(screen.getByText('1 in · 10 points')).toBeInTheDocument();
  });
});
