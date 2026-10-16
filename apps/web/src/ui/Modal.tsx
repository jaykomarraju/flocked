// The modal (Paper Components › Forms and overlays › Modal; docs/design/README.md "Screen conventions
// (Core flow)": sheets become centred 400-wide modals from tablet up): a surface card with a 2px ink
// border, centred on the flat scrim token (never a blur or a shadow). It opens with motion.fade, no
// scale. A real dialog: `role="dialog"`, `aria-modal`, labelled by its `DialogTitle`, focus moved in
// and kept inside, Escape and the close button dismiss it when it is closable, and focus returns to
// where it was. It portals to `document.body` unless `inline` (the design sheets place it in the page).
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './icons/CloseIcon';
import { DialogContext, keepFocus, useDialog, useDialogContext } from './useDialog';
import s from './Modal.module.css';

export { DialogTitle } from './useDialog';

export interface ModalProps {
  open: boolean;
  onClose?: () => void;
  /** False for a modal that must be answered: no Escape, no close button. Default true. */
  closable?: boolean;
  /** Also close on a tap on the scrim (a bottom sheet's content shown as a modal). */
  closeOnScrim?: boolean;
  /** Focus this element on open instead of the dialog itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Render in place rather than in a portal on `document.body` (the design sheets). */
  inline?: boolean;
  /** Extra classes for the scrim (the inline drawing's frame). */
  scrimClassName?: string;
  className?: string;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  closable = true,
  closeOnScrim = false,
  initialFocus,
  inline = false,
  scrimClassName,
  className,
  children,
}: ModalProps) {
  const { context, dialogProps, close } = useDialog({
    open,
    onClose,
    closable,
    initialFocus,
    lockScroll: !inline,
  });
  if (!open) return null;
  const overlay = (
    <div
      className={[s.scrim, inline ? s.inline : s.fixed, scrimClassName].filter(Boolean).join(' ')}
      onMouseDown={keepFocus}
      onClick={(e) => {
        if (closeOnScrim && close && e.target === e.currentTarget) close();
      }}
    >
      <div {...dialogProps} className={className ? `${s.modal} ${className}` : s.modal}>
        <DialogContext.Provider value={context}>{children}</DialogContext.Provider>
      </div>
    </div>
  );
  return inline ? overlay : createPortal(overlay, document.body);
}

/** The modal's close button: a 40px round hit area with the 16px cross. Renders nothing when the
 * dialog can't be closed. */
export function ModalCloseButton({
  label = 'Close',
  className,
}: {
  label?: string;
  className?: string;
}) {
  const ctx = useDialogContext();
  if (!ctx?.close) return null;
  return (
    <button
      type="button"
      aria-label={label}
      className={className ? `${s.close} ${className}` : s.close}
      onClick={ctx.close}
    >
      <CloseIcon />
    </button>
  );
}
