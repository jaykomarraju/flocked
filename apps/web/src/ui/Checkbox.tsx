// The checkbox (Paper `check/age` and `check/terms`, Core flow › Stakes verification sheet): a 24px
// box with a 6px radius, 12 from an Inter 500 16/24 label, on a 32px row. Unticked: a 2px ink border.
// Ticked: an ink fill with the check in bg, so the state never relies on colour alone. Disabled: bg
// fill and a dashed muted border (`box/locked`), not focusable. A native checkbox underneath keeps
// the keyboard, the label and the checked state for assistive tech.
import type { InputHTMLAttributes, ReactNode } from 'react';
import { CheckIcon } from './icons/CheckIcon';
import s from './Checkbox.module.css';

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> & {
  /** The label; may hold a link, e.g. "I accept the Stakes terms". */
  children: ReactNode;
  /** A state the design sheets draw statically. */
  forceState?: 'focus';
};

export function Checkbox({ children, className, forceState, ...input }: CheckboxProps) {
  return (
    <label
      className={className ? `${s.row} ${className}` : s.row}
      data-disabled={input.disabled || undefined}
    >
      <input {...input} type="checkbox" className={s.input} data-force={forceState} />
      <span className={s.box} aria-hidden="true">
        <CheckIcon className={s.check} strokeWidth={2} />
      </span>
      <span className={`type-body ${s.label}`}>{children}</span>
    </label>
  );
}
