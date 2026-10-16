// The pill buttons (Paper Components › Actions; Design_Language.md "Shape and layout"). `primary` is
// the one accent CTA per screen: 56px, the cta label role (the only size allowed on the accent).
// `secondary` is the surface pill with a 2px ink border and a bodyStrong label, 48px, or 36px with a
// 14px label at `size="small"` (Share, Verify). Loading shows a spinner and the loading label in place
// of the label, keeps the button at least as wide as the label (both sit in one grid cell), and marks
// it `aria-busy` and `aria-disabled` so a second press does nothing while focus stays put.
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { SpinnerIcon } from './icons/SpinnerIcon';
import s from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary';
export type ButtonSize = 'default' | 'small';
/** A state the design sheets draw statically; real interaction uses the pseudo-classes. */
export type ButtonForceState = 'hover' | 'pressed' | 'focus';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** In flight: spinner + `loadingLabel` (default: the label), busy, presses ignored. */
  loading?: boolean;
  /** The label while loading, e.g. "Sealing" for "Seal my pick". */
  loadingLabel?: ReactNode;
  forceState?: ButtonForceState;
}

export function Button({
  children,
  variant = 'primary',
  size = 'default',
  loading = false,
  loadingLabel,
  forceState,
  type = 'button',
  className,
  onClick,
  ...rest
}: ButtonProps) {
  const labelClass =
    variant === 'primary'
      ? 'type-cta'
      : size === 'small'
        ? `type-label ${s.smallLabel}`
        : 'type-body-strong';

  function click(e: MouseEvent<HTMLButtonElement>) {
    if (loading) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  }

  return (
    <button
      {...rest}
      type={type}
      aria-busy={loading || undefined}
      aria-disabled={loading || rest['aria-disabled'] || undefined}
      data-variant={variant}
      data-size={size}
      data-force={forceState}
      className={[s.button, className].filter(Boolean).join(' ')}
      onClick={click}
    >
      <span className={s.stack}>
        <span
          className={`${labelClass} ${s.row}`}
          aria-hidden={loading || undefined}
          data-reserve={loading || undefined}
        >
          {children}
        </span>
        {loading ? (
          <span className={`${labelClass} ${s.row}`}>
            <SpinnerIcon className={s.spinner} />
            {loadingLabel ?? children}
          </span>
        ) : null}
      </span>
    </button>
  );
}
