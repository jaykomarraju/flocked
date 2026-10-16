import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SPLIT_FILL_MIN_PX, SplitBars, splitFillWidth } from './SplitBars';

const OPTIONS = ['One horse-sized duck', '100 duck-sized horses'] as const;

/** Each bar's visible text, in order. */
function bars() {
  return within(screen.getByRole('list', { name: 'How the crowd split' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);
}

/** Each bar's fill width (the `--fill` custom property). */
function fills(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('li [aria-hidden="true"] > div')].map((el) =>
    el.style.getPropertyValue('--fill'),
  );
}

describe('splitFillWidth', () => {
  it('is the share of the track', () => {
    expect(splitFillWidth(38, 100)).toBe('clamp(24px, 38%, calc(100% - 24px))');
    expect(splitFillWidth(1, 2)).toBe('clamp(24px, 50%, calc(100% - 24px))');
  });

  it('never drops a partial fill below 24px, nor within 24px of the end', () => {
    expect(SPLIT_FILL_MIN_PX).toBe(24);
    const tiny = splitFillWidth(1, 251);
    expect(tiny.startsWith('clamp(24px, ')).toBe(true);
    expect(tiny.endsWith(', calc(100% - 24px))')).toBe(true);
  });

  it('is empty for no entries and full for all of them', () => {
    expect(splitFillWidth(0, 100)).toBe('0px');
    expect(splitFillWidth(100, 100)).toBe('100%');
    expect(splitFillWidth(0, 0)).toBe('0px');
  });
});

describe('SplitBars', () => {
  it('starts with equal bars and no numbers while unsealing', () => {
    const { container } = render(<SplitBars options={OPTIONS} />);
    expect(bars()).toEqual(['One horse-sized duck', '100 duck-sized horses']);
    expect(fills(container)).toEqual(['50%', '50%']);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('settles to headcount shares, the winner rounding down and the loser up', () => {
    const { container } = render(<SplitBars options={OPTIONS} counts={[3790, 6210]} winner={0} />);
    // 37.9% → 37% for the winner, 62.1% → 63% for the loser.
    expect(screen.getByText('37%')).toBeInTheDocument();
    expect(screen.getByText('63%')).toBeInTheDocument();
    expect(fills(container)).toEqual([splitFillWidth(3790, 10000), splitFillWidth(6210, 10000)]);
  });

  it('names the winner in text, not only in the accent', () => {
    render(<SplitBars options={OPTIONS} counts={[38, 62]} winner={0} />);
    const [duck, horses] = bars();
    expect(duck).toBe('One horse-sized duck38%, the winning side');
    expect(horses).toBe('100 duck-sized horses62%');
  });

  it('keeps the option order and never sorts by share', () => {
    render(<SplitBars options={OPTIONS} counts={[90, 10]} winner={1} />);
    expect(bars()).toEqual([
      'One horse-sized duck90%',
      '100 duck-sized horses10%, the winning side',
    ]);
  });

  it('reads 50% on both sides of a headcount tie, with no winner', () => {
    const { container } = render(<SplitBars options={OPTIONS} counts={[50, 50]} winner={null} />);
    expect(screen.getAllByText('50%')).toHaveLength(2);
    expect(screen.queryByText(/winning side/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-winner]')).toBeNull();
  });

  it('reads <1% and >99% at the extremes, with the tiny side kept visible', () => {
    const { container } = render(<SplitBars options={OPTIONS} counts={[1, 250]} winner={0} />);
    expect(screen.getByText('<1%')).toBeInTheDocument();
    expect(screen.getByText('>99%')).toBeInTheDocument();
    const [tiny, huge] = fills(container);
    expect(tiny).toMatch(/^clamp\(24px, /);
    expect(huge).toMatch(/calc\(100% - 24px\)\)$/);
  });

  it('rounds a refund with no winner so the shares still add to 100%', () => {
    render(<SplitBars options={OPTIONS} counts={[1, 2]} winner={null} />);
    expect(screen.getByText('33%')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
  });

  it('keeps the bars themselves out of the accessibility tree', () => {
    const { container } = render(<SplitBars options={OPTIONS} counts={[38, 62]} winner={0} />);
    const tracks = container.querySelectorAll('li [aria-hidden="true"]');
    expect(tracks).toHaveLength(2);
  });
});
