// The toast (Paper Components › Feedback › Toast): ink fill, bg text, at the bottom of the screen
// above the nav bar, fading in on motion.fade. It leaves after 4 seconds; one at a time, a new one
// replaces the old (the caller keys it by message). A polite live region, so it never interrupts.
import { useEffect } from 'react';
import s from './Toast.module.css';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastProps {
  message: string;
  /** One optional action ("Undo"). */
  action?: ToastAction;
  /** Called when the toast's time is up. Without it the toast stays (e.g. on a design sheet). */
  onDismiss?: () => void;
  /** How long it stays, in ms (Paper: 4 seconds). */
  duration?: number;
  className?: string;
}

export const TOAST_DURATION_MS = 4000;

export function Toast({
  message,
  action,
  onDismiss,
  duration = TOAST_DURATION_MS,
  className,
}: ToastProps) {
  useEffect(() => {
    if (!onDismiss) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [onDismiss, duration, message]);

  return (
    <div role="status" className={className ? `${s.toast} ${className}` : s.toast}>
      <p className={`type-label ${s.message}`}>{message}</p>
      {action && (
        <button type="button" className={`type-label ${s.action}`} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
