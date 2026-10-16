import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DialogTitle, Modal, ModalCloseButton } from './Modal';

function Onboarding({
  closable = true,
  inline = false,
  focusNext = false,
  onClose,
}: {
  closable?: boolean;
  inline?: boolean;
  focusNext?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const next = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        How it works
      </button>
      <p data-testid="outside">The page</p>
      <Modal
        open={open}
        closable={closable}
        inline={inline}
        initialFocus={focusNext ? next : undefined}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
      >
        <div>
          <span>1 of 3</span>
          <ModalCloseButton />
        </div>
        <DialogTitle>Pick the side fewer people pick</DialogTitle>
        <p>One question a day, two answers.</p>
        <button type="button" ref={next}>
          Next
        </button>
      </Modal>
    </>
  );
}

async function openModal(props: Parameters<typeof Onboarding>[0] = {}) {
  const user = userEvent.setup();
  render(<Onboarding {...props} />);
  const trigger = screen.getByRole('button', { name: 'How it works' });
  await user.click(trigger);
  return { user, trigger, dialog: screen.getByRole('dialog') };
}

describe('Modal', () => {
  it('renders nothing while closed', () => {
    render(<Onboarding />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a modal dialog labelled by its title, portalled to the body', async () => {
    const { dialog } = await openModal();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Pick the side fewer people pick');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it('renders in place when inline', async () => {
    const { dialog } = await openModal({ inline: true });
    expect(dialog.parentElement?.parentElement).not.toBe(document.body);
    expect(screen.getByTestId('outside').parentElement).toContainElement(dialog);
  });

  it('moves focus into the dialog on open', async () => {
    const { dialog } = await openModal();
    expect(dialog).toHaveFocus();
  });

  it('focuses the initialFocus element when given', async () => {
    await openModal({ focusNext: true });
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
  });

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const { user } = await openModal();
    const close = screen.getByRole('button', { name: 'Close' });
    const next = screen.getByRole('button', { name: 'Next' });
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(next).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(next).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const onClose = vi.fn();
    const { user, trigger } = await openModal({ onClose });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes from the close button', async () => {
    const onClose = vi.fn();
    const { user, trigger } = await openModal({ onClose });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('ignores Escape and hides the close button when not closable', async () => {
    const onClose = vi.fn();
    const { user } = await openModal({ closable: false, onClose });
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not close on a scrim tap unless asked to', async () => {
    const onClose = vi.fn();
    const { user, dialog } = await openModal({ onClose });
    await user.click(dialog.parentElement!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a scrim tap with closeOnScrim', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open closeOnScrim onClose={onClose}>
        <DialogTitle>Stakes needs a verified account</DialogTitle>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    await user.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks the page scroll while open', async () => {
    const { user } = await openModal();
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('');
  });

  it('leaves the page scroll alone when inline', async () => {
    await openModal({ inline: true });
    expect(document.body.style.overflow).toBe('');
  });
});
