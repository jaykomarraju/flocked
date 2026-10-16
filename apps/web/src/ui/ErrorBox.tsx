// The error box (Paper Components › Feedback › Error): surface, ink border, the error icon and the
// message; never a colour, because the accent belongs to winning. It stays until retried or dismissed.
//   unexpected   VOICE.error with "Retry" (pass `onRetry`)
//   known cause  a 4xx says what happened (e.g. VOICE.entryClosed) and offers no retry when retrying
//                can't help (omit `onRetry`)
import { VOICE } from '@flocked/shared';
import { ErrorIcon } from './icons/ErrorIcon';
import s from './ErrorBox.module.css';

export interface ErrorBoxProps {
  /** What went wrong. Defaults to the unexpected-error line. */
  message?: string;
  /** Offers the retry action. Omit it when retrying can't help (a known 4xx cause). */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorBox({
  message = VOICE.error,
  onRetry,
  retryLabel = 'Retry',
  className,
}: ErrorBoxProps) {
  return (
    <div role="alert" className={className ? `${s.box} ${className}` : s.box}>
      <ErrorIcon className={s.icon} />
      <p className={`type-label ${s.message}`}>{message}</p>
      {onRetry && (
        <button type="button" className={`type-label ${s.retry}`} onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}
