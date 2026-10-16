import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BottomSheet, DialogTitle, DRAG_CLOSE_DISTANCE } from './BottomSheet';
import { Button } from './Button';
import { TextButton } from './TextButton';

function Verify({ closable = true, onClose }: { closable?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    onClose?.();
    setOpen(false);
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Stakes
      </button>
      <BottomSheet open={open} closable={closable} onClose={close}>
        <DialogTitle>Stakes needs a verified account</DialogTitle>
        <p>Verify with Coinbase to play for USDC.</p>
        <Button>Verify with Coinbase</Button>
        <TextButton onClick={close}>Not now</TextButton>
      </BottomSheet>
    </>
  );
}

async function openSheet(props: Parameters<typeof Verify>[0] = {}) {
  const user = userEvent.setup();
  render(<Verify {...props} />);
  const trigger = screen.getByRole('button', { name: 'Stakes' });
  await user.click(trigger);
  return { user, trigger, dialog: screen.getByRole('dialog') };
}

describe('BottomSheet', () => {
  it('is a modal dialog labelled by its title, with focus moved in', async () => {
    const { dialog } = await openSheet();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Stakes needs a verified account');
    expect(dialog).toHaveFocus();
  });

  it('keeps focus inside', async () => {
    const { user } = await openSheet();
    const verify = screen.getByRole('button', { name: 'Verify with Coinbase' });
    const notNow = screen.getByRole('button', { name: 'Not now' });
    await user.tab();
    expect(verify).toHaveFocus();
    await user.tab();
    expect(notNow).toHaveFocus();
    await user.tab();
    expect(verify).toHaveFocus();
    await user.tab({ shift: true });
    expect(notNow).toHaveFocus();
  });

  it('closes on Escape and returns focus', async () => {
    const onClose = vi.fn();
    const { user, trigger } = await openSheet({ onClose });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes from Not now', async () => {
    const onClose = vi.fn();
    const { user, trigger } = await openSheet({ onClose });
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it('closes on a scrim tap, not on a tap inside', async () => {
    const onClose = vi.fn();
    const { user, dialog } = await openSheet({ onClose });
    await user.click(screen.getByText('Verify with Coinbase to play for USDC.'));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the handle is dragged down far enough', async () => {
    const onClose = vi.fn();
    const { dialog } = await openSheet({ onClose });
    const handle = dialog.firstElementChild!;
    expect(handle).toHaveAttribute('aria-hidden', 'true');
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 + DRAG_CLOSE_DISTANCE / 2 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 + DRAG_CLOSE_DISTANCE / 2 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 + DRAG_CLOSE_DISTANCE + 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 + DRAG_CLOSE_DISTANCE + 10 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('must be answered when not closable: no Escape, scrim or drag', async () => {
    const onClose = vi.fn();
    const { user, dialog } = await openSheet({ closable: false, onClose });
    await user.keyboard('{Escape}');
    await user.click(dialog.parentElement!);
    const handle = dialog.firstElementChild!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 400 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 400 });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
