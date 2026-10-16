import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('is a plain button named by its label', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Seal my pick</Button>);
    const button = screen.getByRole('button', { name: 'Seal my pick' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).not.toHaveAttribute('aria-busy');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates from the keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button variant="secondary" onClick={onClick}>
        Remind me
      </Button>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Remind me' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('passes the type through for forms', () => {
    render(<Button type="submit">Seal my pick</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it('is busy while loading: the loading label, presses ignored, focus kept', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading loadingLabel="Sealing" onClick={onClick}>
        Seal my pick
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Sealing' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toBeEnabled();
    await user.tab();
    expect(button).toHaveFocus();
    await user.click(button);
    await user.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the label in place while loading, hidden from assistive tech', () => {
    render(<Button loading>Seal my pick</Button>);
    // The label holds the width; the loading row repeats it when there is no loading label.
    const button = screen.getByRole('button', { name: 'Seal my pick' });
    expect(button.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(2);
  });

  it('is not focusable or pressable when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <>
        <Button disabled onClick={onClick}>
          Seal my pick
        </Button>
        <Button variant="secondary" size="small">
          Share
        </Button>
      </>,
    );
    const button = screen.getByRole('button', { name: 'Seal my pick' });
    expect(button).toBeDisabled();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Share' })).toHaveFocus();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('marks a forced sheet state', () => {
    render(<Button forceState="pressed">Seal my pick</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-force', 'pressed');
  });
});
