import { formatShare } from '@flocked/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OptionCard, OptionGroup } from './OptionCard';

const OPTIONS = [
  { value: 'duck', label: 'One horse-sized duck' },
  { value: 'horses', label: '100 duck-sized horses' },
] as const;

function Pick({
  initial = null,
  disabled = false,
}: {
  initial?: string | null;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <button type="button">Before</button>
      <OptionGroup
        label="Would you rather fight one horse-sized duck or 100 duck-sized horses?"
        options={OPTIONS}
        value={value}
        onChange={setValue}
        disabled={disabled}
      />
      <button type="button">After</button>
    </>
  );
}

describe('OptionCard before the pick', () => {
  it('is a radio named by its label, unchecked until selected', () => {
    const { rerender } = render(<OptionCard label="One horse-sized duck" />);
    const radio = screen.getByRole('radio', { name: 'One horse-sized duck' });
    expect(radio).not.toBeChecked();
    rerender(<OptionCard label="One horse-sized duck" selected />);
    expect(radio).toBeChecked();
  });

  it('draws a check when selected, so the pick never relies on colour', () => {
    const { rerender } = render(<OptionCard label="One horse-sized duck" />);
    const radio = screen.getByRole('radio');
    expect(radio.querySelector('svg')).toBeNull();
    rerender(<OptionCard label="One horse-sized duck" selected />);
    expect(radio.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('picks on click, Space and Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<OptionCard label="One horse-sized duck" onSelect={onSelect} />);
    await user.click(screen.getByRole('radio'));
    await user.keyboard(' ');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it('is not focusable or pickable when disabled', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <>
        <OptionCard label="One horse-sized duck" disabled onSelect={onSelect} />
        <button type="button">Next</button>
      </>,
    );
    const radio = screen.getByRole('radio');
    expect(radio).toBeDisabled();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
    await user.click(radio);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('marks a forced sheet state without changing semantics', () => {
    render(<OptionCard label="One horse-sized duck" forceState="focus" />);
    expect(screen.getByRole('radio')).toHaveAttribute('data-force', 'focus');
  });
});

describe('OptionCard at the reveal', () => {
  it('is static text with the share and, on the player’s side, "Your pick"', () => {
    render(
      <>
        <OptionCard
          label="One horse-sized duck"
          result="win"
          share={formatShare(386, 1000, 'win')}
          yourPick
        />
        <OptionCard
          label="100 duck-sized horses"
          result="loss"
          share={formatShare(614, 1000, 'loss')}
        />
      </>,
    );
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('38%')).toBeInTheDocument();
    expect(screen.getByText('62%')).toBeInTheDocument();
    expect(screen.getAllByText('Your pick')).toHaveLength(1);
  });

  it('shows "Your pick" on a losing side too', () => {
    render(<OptionCard label="100 duck-sized horses" result="loss" share="62%" yourPick />);
    expect(screen.getByText('Your pick')).toBeInTheDocument();
    expect(screen.getByText('100 duck-sized horses')).toBeInTheDocument();
  });
});

describe('OptionGroup', () => {
  it('is a radiogroup named by the question', () => {
    render(<Pick />);
    const group = screen.getByRole('radiogroup', {
      name: 'Would you rather fight one horse-sized duck or 100 duck-sized horses?',
    });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('has one tab stop: the first card before a pick', async () => {
    const user = userEvent.setup();
    render(<Pick />);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('radio', { name: 'One horse-sized duck' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('has one tab stop: the picked card after a pick', async () => {
    const user = userEvent.setup();
    render(<Pick initial="horses" />);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('radio', { name: '100 duck-sized horses' })).toHaveFocus();
  });

  it('moves the pick and focus with the arrow keys, wrapping', async () => {
    const user = userEvent.setup();
    render(<Pick />);
    const duck = screen.getByRole('radio', { name: 'One horse-sized duck' });
    const horses = screen.getByRole('radio', { name: '100 duck-sized horses' });
    await user.tab();
    await user.tab();
    await user.keyboard('{ArrowDown}');
    expect(horses).toBeChecked();
    expect(horses).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(duck).toBeChecked();
    expect(duck).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(horses).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(duck).toBeChecked();
    expect(horses).not.toBeChecked();
  });

  it('picks on click', async () => {
    const user = userEvent.setup();
    render(<Pick />);
    await user.click(screen.getByRole('radio', { name: '100 duck-sized horses' }));
    expect(screen.getByRole('radio', { name: '100 duck-sized horses' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'One horse-sized duck' })).not.toBeChecked();
  });

  it('disables every card when the round is closed', async () => {
    const user = userEvent.setup();
    render(<Pick initial="duck" disabled />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });
});
