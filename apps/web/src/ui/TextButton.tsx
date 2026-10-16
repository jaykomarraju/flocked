// The text button (Paper `text-button/not-now`, Components › Forms and overlays): the "Not now" that
// closes an optional sheet or modal (docs/design/README.md "Component conventions"). Inter 600 16/24,
// underlined, in a 48px-tall hit area.
import type { ButtonHTMLAttributes } from 'react';
import s from './TextButton.module.css';

export type TextButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** A state the design sheets draw statically. */
  forceState?: 'focus';
};

export function TextButton({ type = 'button', className, forceState, ...rest }: TextButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      data-force={forceState}
      className={['type-body-strong', s.button, className].filter(Boolean).join(' ')}
    />
  );
}
