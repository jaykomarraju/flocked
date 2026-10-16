import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ArchiveList, ArchiveRow, MiniSplit } from './ArchiveRow';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderRows() {
  render(
    <MemoryRouter>
      <ArchiveList>
        <ArchiveRow
          to="/r/6"
          date="Tue, Oct 6"
          mode="free"
          question="Would you rather fight one horse-sized duck or 100 duck-sized horses?"
          result="win"
          split={{ first: 38, winner: 'first' }}
        />
        <ArchiveRow
          to="/r/5"
          date="Mon, Oct 5"
          mode="stakes"
          question="Is a hot dog a sandwich?"
          result="loss"
          split={{ first: 71, winner: 'second' }}
        />
        <ArchiveRow
          to="/r/4"
          date="Sun, Oct 4"
          mode="free"
          question="Cereal: milk first or cereal first?"
          result="refunded"
          split={{ first: 50, winner: 'tie' }}
        />
      </ArchiveList>
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ArchiveRow', () => {
  it('is a list of links, one per round, named by date, mode, question and result', () => {
    renderRows();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const win = screen.getByRole('link', { name: /Is a hot dog a sandwich\?/ });
    expect(win).toHaveAccessibleName('Mon, Oct 5 · Stakes Is a hot dog a sandwich? Got flocked');
    expect(screen.getByRole('link', { name: /horse-sized duck.*Unflocked$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /milk first.*Refunded$/ })).toBeInTheDocument();
  });

  it('links the whole row to Round detail', async () => {
    const user = userEvent.setup();
    renderRows();
    await user.click(screen.getByText('Is a hot dog a sandwich?'));
    expect(screen.getByTestId('where')).toHaveTextContent('/r/5');
  });

  it('keeps the split out of the accessible name', () => {
    renderRows();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('MiniSplit', () => {
  it('sizes the first side to its share and marks only the winner', () => {
    const { container } = render(<MiniSplit first={38} winner="first" />);
    const [first, second] = Array.from(container.firstElementChild!.children) as HTMLElement[];
    expect(first!.style.width).toBe('round(38%, 1px)');
    expect(first).toHaveAttribute('data-winner', 'true');
    expect(second).not.toHaveAttribute('data-winner');
  });

  it('marks neither side on a tie', () => {
    const { container } = render(<MiniSplit first={50} winner="tie" />);
    expect(container.querySelectorAll('[data-winner]')).toHaveLength(0);
  });

  it('clamps the share to 0..100', () => {
    const { container } = render(<MiniSplit first={140} winner="second" />);
    const first = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(first.style.width).toBe('round(100%, 1px)');
  });

  it('is an image with a name when labelled', () => {
    render(<MiniSplit first={38} winner="first" label="38% picked the duck, 62% the horses" />);
    expect(
      screen.getByRole('img', { name: '38% picked the duck, 62% the horses' }),
    ).toBeInTheDocument();
  });
});
