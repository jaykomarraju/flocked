import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TextButton } from './TextButton';

describe('TextButton', () => {
  it('is a plain button that does not submit forms', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <TextButton onClick={onClick}>Not now</TextButton>
      </form>,
    );
    const button = screen.getByRole('button', { name: 'Not now' });
    expect(button).toHaveAttribute('type', 'button');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('activates from the keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<TextButton onClick={onClick}>Not now</TextButton>);
    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is not focusable when disabled', async () => {
    const user = userEvent.setup();
    render(<TextButton disabled>Not now</TextButton>);
    await user.tab();
    expect(screen.getByRole('button')).not.toHaveFocus();
  });
});
