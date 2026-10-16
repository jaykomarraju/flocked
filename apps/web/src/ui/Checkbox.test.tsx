import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('is a checkbox named by its label', () => {
    render(<Checkbox>I&apos;m 18 or older</Checkbox>);
    const box = screen.getByRole('checkbox', { name: "I'm 18 or older" });
    expect(box).not.toBeChecked();
  });

  it('toggles from the label and from the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox onChange={onChange}>I&apos;m 18 or older</Checkbox>);
    const box = screen.getByRole('checkbox');
    await user.tab();
    expect(box).toHaveFocus();
    await user.keyboard(' ');
    expect(box).toBeChecked();
    await user.click(screen.getByText("I'm 18 or older"));
    expect(box).not.toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('takes a label with a link inside', () => {
    render(
      <Checkbox defaultChecked>
        I accept the <a href="/terms">Stakes terms</a>
      </Checkbox>,
    );
    expect(screen.getByRole('checkbox', { name: 'I accept the Stakes terms' })).toBeChecked();
    expect(screen.getByRole('link', { name: 'Stakes terms' })).toHaveAttribute('href', '/terms');
  });

  it('is controlled when given checked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Checkbox checked onChange={onChange}>
        I&apos;m 18 or older
      </Checkbox>,
    );
    await user.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('is disabled and not focusable when disabled', async () => {
    const user = userEvent.setup();
    render(
      <Checkbox disabled defaultChecked>
        Locked
      </Checkbox>,
    );
    const box = screen.getByRole('checkbox', { name: 'Locked' });
    expect(box).toBeDisabled();
    await user.tab();
    expect(box).not.toHaveFocus();
    await user.click(box);
    expect(box).toBeChecked();
  });
});
