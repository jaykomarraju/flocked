import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeaderboardList, LeaderboardRow } from './LeaderboardRow';

/** The component's stylesheet source (Vitest runs with `css: false`, so CSS imports are proxies). */
function stylesheet(): string {
  const { process } = globalThis as unknown as {
    process: {
      getBuiltinModule(id: 'node:fs'): { readFileSync(path: string, enc: 'utf8'): string };
    };
  };
  return process
    .getBuiltinModule('node:fs')
    .readFileSync(
      decodeURIComponent(new URL(import.meta.url).pathname).replace(
        /[^/]+$/,
        'LeaderboardRow.module.css',
      ),
      'utf8',
    );
}

function renderBoard() {
  render(
    <LeaderboardList aria-label="Streaks">
      <LeaderboardRow
        rank={1}
        handle="woolgatherer"
        caption="Still running"
        value={14}
        valueLabel="rounds"
        highlight
      />
      <LeaderboardRow rank={2} handle="baa_humbug" caption="Ended Oct 5" value={11} />
      <LeaderboardRow rank={148} handle="@jay" value={3} you pinned />
    </LeaderboardList>,
  );
  return within(screen.getByRole('list', { name: 'Streaks' })).getAllByRole('listitem');
}

describe('LeaderboardRow', () => {
  it('reads rank, handle, caption and value in order', () => {
    const [first, second] = renderBoard();
    expect(first).toHaveTextContent('Rank 1W@woolgathererStill running14 rounds');
    expect(second).toHaveTextContent('Rank 2B@baa_humbugEnded Oct 511');
  });

  it('puts the board top live streak in the accent pill, and only that one', () => {
    const [first, second] = renderBoard();
    expect(within(first!).getByText('14').closest('[data-highlight]')).not.toBeNull();
    expect(within(second!).getByText('11').closest('[data-highlight]')).toBeNull();
  });

  it('marks your row with a You pill and aria-current, without doubling the @', () => {
    const rows = renderBoard();
    const you = rows[2]!;
    expect(you).toHaveAttribute('aria-current', 'true');
    expect(within(you).getByText('You')).toBeInTheDocument();
    expect(within(you).getByText('@jay')).toBeInTheDocument();
    expect(rows[0]).not.toHaveAttribute('aria-current');
  });

  it('shows a 3-digit rank whole', () => {
    const rows = renderBoard();
    expect(rows[2]).toHaveTextContent(/^Rank 148/);
  });

  it('keeps the rank slot 32 wide and unshrinkable, so 148 fits', () => {
    const rank = /\.rank\s*\{([^}]*)\}/.exec(stylesheet())?.[1] ?? '';
    expect(rank).toMatch(/width:\s*32px/);
    expect(rank).toMatch(/flex-shrink:\s*0/);
  });

  it('draws the avatar initial for every row', () => {
    const rows = renderBoard();
    expect(rows.map((r) => r.querySelector('[aria-hidden="true"]')?.textContent)).toEqual([
      'W',
      'B',
      'J',
    ]);
  });
});
