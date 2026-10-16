// The bottom sheet (Paper Components › Forms and overlays › Bottom sheet): mobile choices and
// confirmations. A surface panel with a 2px ink border on three sides and a handle, at the bottom of
// the flat scrim; it slides up on motion.spring. Drag the handle down, tap the scrim or use Not now
// (a `TextButton` calling `onClose`) to close. Same dialog behaviour as the Modal: `role="dialog"`,
// `aria-modal`, labelled by its `DialogTitle`, focus moved in and kept inside, Escape closes it when
// it is closable, focus returns on close. From tablet up the same content goes in a `Modal`.
import { useRef, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { DialogContext, keepFocus, useDialog } from './useDialog';
import s from './BottomSheet.module.css';

export { DialogTitle } from './useDialog';

/** How far (px) the handle must be dragged down to close the sheet. */
export const DRAG_CLOSE_DISTANCE = 80;

export interface BottomSheetProps {
  open: boolean;
  onClose?: () => void;
  /** False for a sheet that must be answered: no Escape, scrim or drag to close. Default true. */
  closable?: boolean;
  /** Focus this element on open instead of the dialog itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Render in place rather than in a portal on `document.body` (the design sheets). */
  inline?: boolean;
  /** Extra classes for the scrim (the inline drawing's frame). */
  scrimClassName?: string;
  className?: string;
  children: ReactNode;
}

export function BottomSheet({
  open,
  onClose,
  closable = true,
  initialFocus,
  inline = false,
  scrimClassName,
  className,
  children,
}: BottomSheetProps) {
  const { context, dialogProps, close } = useDialog({
    open,
    onClose,
    closable,
    initialFocus,
    lockScroll: !inline,
  });
  const drag = useRef<{ id: number; startY: number; dy: number } | null>(null);

  /** Moves the sheet with the finger (no transition while dragging; it eases back on release). */
  function setOffset(dy: number, dragging: boolean) {
    const node = dialogProps.ref.current;
    if (!node) return;
    node.style.transition = dragging ? 'none' : '';
    node.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!close) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, startY: e.clientY, dy: 0 };
    setOffset(0, true);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = Math.max(0, e.clientY - d.startY);
    setOffset(d.dy, true);
  }

  function onPointerEnd(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setOffset(0, false);
    if (d.dy >= DRAG_CLOSE_DISTANCE) close?.();
  }

  if (!open) return null;
  const overlay = (
    <div
      className={[s.scrim, inline ? s.inline : s.fixed, scrimClassName].filter(Boolean).join(' ')}
      onMouseDown={keepFocus}
      onClick={(e) => {
        if (close && e.target === e.currentTarget) close();
      }}
    >
      <div {...dialogProps} className={className ? `${s.sheet} ${className}` : s.sheet}>
        <div
          className={s.handle}
          aria-hidden="true"
          data-draggable={close ? 'true' : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        />
        <DialogContext.Provider value={context}>{children}</DialogContext.Provider>
      </div>
    </div>
  );
  return inline ? overlay : createPortal(overlay, document.body);
}
