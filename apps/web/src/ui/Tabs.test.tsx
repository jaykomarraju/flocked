import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs, tabPanelProps, type TabItem } from './Tabs';

const TABS: TabItem[] = [
  { id: 'strays', label: 'Strays today' },
  { id: 'streaks', label: 'Streaks' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'creators', label: 'Creators' },
];

function Boards({ initial = 'strays' }: { initial?: string }) {
  const [tab, setTab] = useState(initial);
  return (
    <>
      <button type="button">Before</button>
      <Tabs label="Leaderboards" idPrefix="boards" tabs={TABS} value={tab} onChange={setTab} />
      <div {...tabPanelProps('boards', tab)}>Board for {tab}</div>
    </>
  );
}

describe('Tabs', () => {
  it('is a named tablist with the active tab selected', () => {
    render(<Boards />);
    expect(screen.getByRole('tablist', { name: 'Leaderboards' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tab', { name: 'Strays today' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Streaks' })).toHaveAttribute('aria-selected', 'false');
  });

  it('links the active tab and its panel', () => {
    render(<Boards initial="weekly" />);
    const tab = screen.getByRole('tab', { name: 'Weekly' });
    const panel = screen.getByRole('tabpanel', { name: 'Weekly' });
    expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveTextContent('Board for weekly');
  });

  it('selects on click', async () => {
    const user = userEvent.setup();
    render(<Boards />);
    await user.click(screen.getByRole('tab', { name: 'Creators' }));
    expect(screen.getByRole('tab', { name: 'Creators' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Creators' })).toBeInTheDocument();
  });

  it('does not re-select the active tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Tabs label="Leaderboards" idPrefix="b" tabs={TABS} value="strays" onChange={onChange} />,
    );
    await user.click(screen.getByRole('tab', { name: 'Strays today' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has one tab stop, the active tab, then the panel', async () => {
    const user = userEvent.setup();
    render(<Boards initial="streaks" />);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Streaks' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('tabpanel')).toHaveFocus();
  });

  it('moves with the arrow keys (wrapping), Home and End, selecting as it goes', async () => {
    const user = userEvent.setup();
    render(<Boards />);
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Streaks' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Streaks' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Creators' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Strays today' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Creators' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Strays today' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel', { name: 'Strays today' })).toBeInTheDocument();
  });
});
