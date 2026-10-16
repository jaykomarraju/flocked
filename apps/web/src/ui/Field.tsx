// The form field (Paper Components › Forms and overlays › Form field): the label above, a 52px input
// with a 2px ink border and a 16 radius in body text, and the helper (with a length counter when the
// field has a `maxLength`) below. Focus adds the foundation ring. An error is ink, never a colour: the
// border thickens to 3px, the error icon appears and a 600-weight message replaces the helper; the
// input is then `aria-invalid` and described by the message.
import { useId, useState, type ChangeEvent, type InputHTMLAttributes } from 'react';
import { ErrorIcon } from './icons/ErrorIcon';
import s from './Field.module.css';

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'children'> & {
  label: string;
  /** The hint under the field, e.g. "Two sides, ends with a question mark." */
  helper?: string;
  /** The error message. Replaces the helper and counter while set. */
  error?: string | null;
  /** A state the design sheets draw statically. */
  forceState?: 'focus';
};

export function Field({
  label,
  helper,
  error,
  forceState,
  id,
  className,
  maxLength,
  value,
  defaultValue,
  onChange,
  'aria-describedby': describedBy,
  ...input
}: FieldProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const helperId = `${autoId}-helper`;
  const counterId = `${autoId}-counter`;
  const errorId = `${autoId}-error`;
  const [typed, setTyped] = useState(() => String(defaultValue ?? ''));
  const length = value === undefined ? typed.length : String(value).length;
  const hasError = Boolean(error);
  const showCounter = maxLength !== undefined && !hasError;

  const describedByIds = [
    describedBy,
    hasError ? errorId : helper ? helperId : undefined,
    showCounter ? counterId : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  function change(e: ChangeEvent<HTMLInputElement>) {
    if (value === undefined) setTyped(e.target.value);
    onChange?.(e);
  }

  return (
    <div className={className ? `${s.field} ${className}` : s.field}>
      <label htmlFor={inputId} className={`type-label ${s.label}`}>
        {label}
      </label>
      <div className={s.control}>
        <input
          {...input}
          id={inputId}
          className={`type-body ${s.input}`}
          maxLength={maxLength}
          value={value}
          defaultValue={defaultValue}
          onChange={change}
          aria-invalid={hasError || undefined}
          aria-describedby={describedByIds || undefined}
          data-error={hasError || undefined}
          data-force={forceState}
        />
        {hasError && <ErrorIcon className={s.errorIcon} width={20} height={20} />}
      </div>
      {hasError ? (
        <p id={errorId} className={`type-caption ${s.error}`}>
          {error}
        </p>
      ) : helper || showCounter ? (
        <div className={s.footer}>
          {helper && (
            <p id={helperId} className={`type-caption ${s.helper}`}>
              {helper}
            </p>
          )}
          {showCounter && (
            <p id={counterId} className={`type-caption tnum ${s.counter}`}>
              {length}/{maxLength}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
