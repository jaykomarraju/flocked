import { VOICE } from '@flocked/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResultCard } from './ResultCard';

describe('ResultCard', () => {
  it('names the region by the result line and reads the win line with the share rounded down', () => {
    render(
      <ResultCard
        result="unflocked"
        count={386}
        total={1000}
        stake="25 points"
        figure={{ label: 'Won', value: '+38 points' }}
      />,
    );
    const card = screen.getByRole('region', { name: 'Unflocked' });
    expect(within(card).getByRole('heading', { name: 'Unflocked' })).toBeInTheDocument();
    expect(card).toHaveTextContent('Unflocked. You and 38% of people out-thought everyone.');
  });

  it('reads the loss line with the losing share rounded up', () => {
    render(
      <ResultCard
        result="got-flocked"
        count={614}
        total={1000}
        stake="25 points"
        figure={{ label: 'Lost', value: '−25 points' }}
      />,
    );
    const card = screen.getByRole('region', { name: 'Got flocked' });
    expect(card).toHaveTextContent('You got flocked. 62% thought the same thing you did.');
  });

  it('defaults a refund to the tie line and takes another reason line', () => {
    const { rerender } = render(
      <ResultCard
        result="refunded"
        stake="25 points"
        figure={{ label: 'Returned', value: '25 points' }}
      />,
    );
    expect(screen.getByRole('region', { name: 'Refunded' })).toHaveTextContent(VOICE.refundedTie);
    rerender(
      <ResultCard
        result="refunded"
        line="Not enough sheep showed up. Everyone gets their stake back."
        stake="25 points"
        figure={{ label: 'Returned', value: '25 points' }}
      />,
    );
    expect(screen.getByRole('region', { name: 'Refunded' })).toHaveTextContent(
      'Not enough sheep showed up.',
    );
  });

  it('lists the stake and the second figure as term and value pairs', () => {
    render(
      <ResultCard
        result="unflocked"
        count={386}
        total={1000}
        stake="5 USDC"
        figure={{ label: 'Payout, once final', value: '12.67 USDC' }}
      />,
    );
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    const values = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(terms).toEqual(['Stake', 'Payout, once final']);
    expect(values).toEqual(['5 USDC', '12.67 USDC']);
  });

  it('shows the "Final at" chip only while the result is provisional', () => {
    const props = {
      result: 'unflocked',
      count: 386,
      total: 1000,
      stake: '5 USDC',
      figure: { label: 'Payout, once final', value: '12.67 USDC' },
    } as const;
    const { rerender } = render(<ResultCard {...props} finalAt="11:03pm" />);
    expect(screen.getByText('Provisional. Final at 11:03pm')).toBeInTheDocument();
    rerender(<ResultCard {...props} />);
    expect(screen.queryByText(/Provisional/)).not.toBeInTheDocument();
  });

  it('keeps the sheep decorative and picks its pose from the result', () => {
    const { container, rerender } = render(
      <ResultCard
        result="unflocked"
        count={1}
        total={3}
        stake="25 points"
        figure={{ label: 'Won', value: '+38 points' }}
      />,
    );
    const sheep = () => container.querySelector('svg[data-pose]');
    expect(sheep()).toHaveAttribute('aria-hidden', 'true');
    expect(sheep()).toHaveAttribute('data-pose', 'smug');
    rerender(
      <ResultCard
        result="got-flocked"
        count={2}
        total={3}
        stake="25 points"
        figure={{ label: 'Lost', value: '−25 points' }}
      />,
    );
    expect(sheep()).toHaveAttribute('data-pose', 'shocked');
    rerender(
      <ResultCard
        result="refunded"
        stake="25 points"
        figure={{ label: 'Returned', value: '25 points' }}
      />,
    );
    expect(sheep()).toHaveAttribute('data-pose', 'neutral');
  });
});
