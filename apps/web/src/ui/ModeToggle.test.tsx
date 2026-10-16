import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModeToggle, type Mode } from './ModeToggle';

function Toggle({ initial = 'free' }: { initial?: Mode }) {
  const [mode, setMode] = useState<Mode>(initial);
  return (
    <>
      <button type="button">Before</button>
      <ModeToggle value={mode} onChange={setMode} />
      <button type="button">After</button>
    </>
  );
}

describe('ModeToggle', () => {
  it('is a radiogroup of Free and Stakes with the mode checked', () => {
    render(<ModeToggle value="free" onChange={() => undefined} />);
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Free' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Stakes' })).not.toBeChecked();
  });

  it('takes a group name', () => {
    render(<ModeToggle value="free" onChange={() => undefined} label="Board mode" />);
    expect(screen.getByRole('radiogroup', { name: 'Board mode' })).toBeInTheDocument();
  });

  it('marks the active mode with a check, not colour alone', () => {
    render(<ModeToggle value="stakes" onChange={() => undefined} />);
    expect(screen.getByRole('radio', { name: 'Stakes' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Free' }).querySelector('svg')).toBeNull();
  });

  it('switches on click, and clicking the active mode does nothing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModeToggle value="free" onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Free' }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: 'Stakes' }));
    expect(onChange).toHaveBeenCalledWith('stakes');
  });

  it('has one tab stop, the active mode', async () => {
    const user = userEvent.setup();
    render(<Toggle initial="stakes" />);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Stakes' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('switches with the arrow keys and moves focus', async () => {
    const user = userEvent.setup();
    render(<Toggle />);
    const free = screen.getByRole('radio', { name: 'Free' });
    const stakes = screen.getByRole('radio', { name: 'Stakes' });
    await user.tab();
    await user.tab();
    expect(free).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(stakes).toBeChecked();
    expect(stakes).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(free).toBeChecked();
    expect(free).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(stakes).toBeChecked();
    await user.keyboard('{ArrowUp}');
    expect(free).toBeChecked();
  });

  it('is a static "Free" label when Stakes is hidden', () => {
    render(<ModeToggle value="free" onChange={() => undefined} stakesAvailable={false} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Free')).toBeInTheDocument();
  });
});
