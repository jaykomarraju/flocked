// The dialog behaviour the Modal and the BottomSheet share (Paper Components › Forms and overlays:
// "Close and Escape dismiss; focus stays inside"): focus moves into the dialog when it opens, Tab
// and Shift+Tab wrap inside it, Escape closes it when it is closable, and focus goes back to where it
// was when it closes. The dialog is labelled by its `DialogTitle`.
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type ElementType,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

/** The focusable elements inside `root`, in tab order (document order; positive tabindex unused). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

interface DialogContextValue {
  titleId: string;
  /** Closes the dialog, when it is closable. */
  close?: () => void;
}

export const DialogContext = createContext<DialogContextValue | null>(null);

/** The open dialog's context: its title id and its close action. */
export function useDialogContext(): DialogContextValue | null {
  return useContext(DialogContext);
}

/** The dialog's title: the element that names it (`aria-labelledby`). */
export function DialogTitle({
  as: Tag = 'h2',
  className,
  children,
}: {
  as?: ElementType;
  className?: string;
  children: ReactNode;
}) {
  const ctx = useDialogContext();
  return (
    <Tag id={ctx?.titleId} className={className}>
      {children}
    </Tag>
  );
}

export interface DialogOptions {
  open: boolean;
  /** Called by Escape, the close button, Not now and (where the overlay allows) the scrim. */
  onClose?: () => void;
  /** False for a dialog that must be answered: Escape and the scrim then do nothing. */
  closable: boolean;
  /** The element to focus on open; defaults to the dialog itself, which announces its title. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Lock the page's scroll while open (overlays on the page, not the inline sheet drawings). */
  lockScroll: boolean;
}

export function useDialog({ open, onClose, closable, initialFocus, lockScroll }: DialogOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = closable && onClose ? onClose : undefined;

  // Focus in on open, back out on close.
  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus?.current ?? node).focus({ preventScroll: true });
    return () => {
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
    // Only on open and close: a new initialFocus ref mid-dialog doesn't move focus.
  }, [open]);

  useEffect(() => {
    if (!open || !lockScroll) return;
    const body = document.body;
    const before = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = before;
    };
  }, [open, lockScroll]);

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    const node = ref.current;
    if (!node) return;
    if (e.key === 'Escape') {
      // Handled here, so a dialog inside a dialog closes only itself.
      e.stopPropagation();
      if (close) {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusableIn(node);
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!first || !last) {
      e.preventDefault();
      node.focus();
    } else if (e.shiftKey && (active === first || active === node)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const context: DialogContextValue = { titleId, close };
  const dialogProps = {
    ref,
    role: 'dialog' as const,
    'aria-modal': true as const,
    'aria-labelledby': titleId,
    tabIndex: -1,
    onKeyDown,
  };
  return { context, dialogProps, close };
}

/** Clicks on the scrim must not take focus out of the dialog (it is not focusable). */
export function keepFocus(e: {
  target: EventTarget;
  currentTarget: EventTarget;
  preventDefault(): void;
}) {
  if (e.target === e.currentTarget) e.preventDefault();
}
