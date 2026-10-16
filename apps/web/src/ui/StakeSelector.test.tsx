import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StakeSelector } from './StakeSelector';

/** A Free selector that holds its own value, as a screen would. */
function Free({ initial, balance }: { initial: number; balance?: number }) {
  const [value, setValue] = useState(initial);
  return <StakeSelector mode="free" value={value} onChange={setValue} balance={balance} />;
}

const presets = () =>
  within(screen.getByRole('radiogroup', { name: 'Stake presets' })).getAllByRole('radio');
const slider = () => screen.getByRole('slider', { name: 'Stake' });

describe('StakeSelector, Free', () => {
  it('shows the value, the presets as a radio group and a labelled slider', () => {
    render(<Free initial={25} />);
    // The value in numberXL and the picked preset.
    expect(screen.getAllByText('25')).toHaveLength(2);
    expect(presets().map((r) => r.textContent)).toEqual(['10', '25', '50', '100']);
    expect(screen.getByRole('radio', { name: '25' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '10' })).not.toBeChecked();
    expect(slider()).toHaveValue('25');
    expect(slider()).toHaveAttribute('aria-valuetext', '25 points');
    expect(slider()).toHaveAttribute('min', '10');
    expect(slider()).toHaveAttribute('max', '100');
  });

  it('sets the value from a preset', async () => {
    const user = userEvent.setup();
    render(<Free initial={25} />);
    await user.click(screen.getByRole('radio', { name: '50' }));
    expect(screen.getByRole('radio', { name: '50' })).toBeChecked();
    expect(slider()).toHaveValue('50');
    expect(slider()).toHaveAttribute('aria-valuetext', '50 points');
  });

  it('leaves no preset picked when the slider sits between presets', () => {
    render(<Free initial={25} />);
    fireEvent.change(slider(), { target: { value: '63' } });
    expect(slider()).toHaveValue('63');
    expect(slider()).toHaveAttribute('aria-valuetext', '63 points');
    for (const radio of presets()) expect(radio).not.toBeChecked();
    // The group stays reachable: its first preset becomes the tab stop.
    expect(presets()[0]).toHaveAttribute('tabindex', '0');
  });

  it('moves between presets with the arrow keys (one tab stop)', async () => {
    const user = userEvent.setup();
    render(<Free initial={25} />);
    const [ten, twentyFive, fifty, hundred] = presets();
    expect(twentyFive).toHaveAttribute('tabindex', '0');
    expect(ten).toHaveAttribute('tabindex', '-1');
    await user.click(twentyFive!);
    await user.keyboard('{ArrowRight}');
    expect(fifty).toBeChecked();
    expect(fifty).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(ten).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(hundred).toBeChecked();
  });

  it('moves the slider 10 with Page Up and Page Down, within the range', () => {
    const onChange = vi.fn();
    render(<StakeSelector mode="free" value={95} onChange={onChange} />);
    fireEvent.keyDown(slider(), { key: 'PageUp' });
    expect(onChange).toHaveBeenLastCalledWith(100);
    fireEvent.keyDown(slider(), { key: 'PageDown' });
    expect(onChange).toHaveBeenLastCalledWith(85);
  });

  it('disables presets above a low balance and stops the slider at it', async () => {
    const user = userEvent.setup();
    render(<Free initial={40} balance={40} />);
    const [ten, twentyFive, fifty, hundred] = presets();
    expect(fifty).toBeDisabled();
    expect(hundred).toBeDisabled();
    expect(ten).toBeEnabled();
    expect(slider()).toHaveAttribute('max', '40');
    expect(slider()).toHaveAccessibleDescription('40, your balance');
    // Arrow keys skip the disabled presets.
    await user.click(twentyFive!);
    await user.keyboard('{ArrowRight}');
    expect(ten).toBeChecked();
  });

  it('shows the plain range ends without a balance limit', () => {
    render(<Free initial={25} balance={500} />);
    // The 100 preset and the slider's top end.
    expect(screen.getAllByText('100')).toHaveLength(2);
    expect(screen.queryByText(/your balance/)).not.toBeInTheDocument();
    for (const radio of presets()) expect(radio).toBeEnabled();
  });
});

describe('StakeSelector, Stakes', () => {
  it('shows the fixed stake read-only, the same for everyone', () => {
    render(<StakeSelector mode="stakes" stake={5_000_000n} />);
    const box = screen.getByRole('group', { name: 'Stake' });
    expect(box).toHaveTextContent('5USDC');
    expect(within(box).getByText('Same for everyone')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a stake with cents to two decimals', () => {
    render(<StakeSelector mode="stakes" stake={2_500_000n} />);
    expect(screen.getByText('2.50')).toBeInTheDocument();
  });

  it('shows the cap and the cap line over the daily cap', () => {
    render(<StakeSelector mode="stakes" stake={5_000_000n} dailyCap={100_000_000n} overCap />);
    expect(screen.getByText('Cap 100 USDC a day')).toBeInTheDocument();
    expect(
      screen.getByText("You've hit today's cap. The flock will still be here tomorrow."),
    ).toBeInTheDocument();
    expect(screen.queryByText('Same for everyone')).not.toBeInTheDocument();
  });
});
