// The option card (Paper Components › Option card; Design_Language.md "Shape and layout"). Two per
// question. Before the reveal each card is a radio: picking one of two answers, changeable until the
// CTA seals it, is a single choice, so the cards are `role="radio"` buttons in a `radiogroup` (a
// <button> keeps Space and Enter picking, as the sheet notes, and `disabled` drops it from the tab
// order). `OptionGroup` is that group: it owns the roving tab stop and the arrow keys (WAI-ARIA radio
// group). At the reveal the card is static: the winning (stray) side takes the accent, the losing
// (flock) side stays ink on surface, and each shows its headcount share. Shares arrive as text from
// `formatShare` (@flocked/shared); this component never computes one.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { CheckIcon } from './icons/CheckIcon';
import s from './OptionCard.module.css';

/** A state the design sheets draw statically; real interaction uses the pseudo-classes. */
export type OptionCardForceState = 'hover' | 'pressed' | 'focus';

interface PickProps {
  label: ReactNode;
  /** This card is the current pick: ink fill and a checked radio. */
  selected?: boolean;
  /** Round closed or already entered: not focusable, not pickable. */
  disabled?: boolean;
  onSelect?: () => void;
  /** The roving tab stop (`OptionGroup` sets it). */
  tabIndex?: number;
  forceState?: OptionCardForceState;
  className?: string;
  result?: undefined;
}

interface RevealProps {
  label: ReactNode;
  /** Win: the side fewer people picked (accent). Loss: the flock (monochrome). */
  result: 'win' | 'loss';
  /** The side's headcount share as text, from `formatShare` ("38%", "<1%"). */
  share: string;
  /** Show the "Your pick" pill. */
  yourPick?: boolean;
  className?: string;
}

export type OptionCardProps = PickProps | RevealProps;

export function OptionCard(props: OptionCardProps) {
  if (props.result !== undefined) return <RevealedCard {...props} />;
  const {
    label,
    selected = false,
    disabled = false,
    onSelect,
    tabIndex,
    forceState,
    className,
  } = props;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      tabIndex={tabIndex}
      data-force={forceState}
      className={[s.card, s.pick, className].filter(Boolean).join(' ')}
      onClick={onSelect}
    >
      <span className={`type-option ${s.label}`}>{label}</span>
      <span className={s.radio} aria-hidden="true">
        {selected ? <CheckIcon className={s.check} /> : null}
      </span>
    </button>
  );
}

function RevealedCard({ label, result, share, yourPick = false, className }: RevealProps) {
  return (
    <div data-result={result} className={[s.card, s.revealed, className].filter(Boolean).join(' ')}>
      <div className={s.text}>
        {yourPick ? <span className={`type-label ${s.yourPick}`}>Your pick</span> : null}
        <span className={result === 'win' ? 'type-cta' : 'type-option'}>{label}</span>
      </div>
      <span className={`type-number-xl ${s.share}`}>{share}</span>
    </div>
  );
}

export interface OptionGroupOption {
  value: string;
  label: ReactNode;
}

export interface OptionGroupProps {
  /** The two answers, in the question's order. */
  options: readonly OptionGroupOption[];
  /** The picked value, or null before a pick. */
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** The id of the element that names the group (the question). */
  labelledBy?: string;
  /** Or a name, when the question isn't on screen. */
  label?: string;
  className?: string;
}

/**
 * The pick: a `radiogroup` of option cards. One tab stop (the picked card, or the first one before
 * a pick); arrow keys move the pick and focus to the next or previous card, wrapping.
 */
export function OptionGroup({
  options,
  value,
  onChange,
  disabled = false,
  labelledBy,
  label,
  className,
}: OptionGroupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const tabStop = options.some((o) => o.value === value) ? value : (options[0]?.value ?? null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (step === 0 || disabled || options.length === 0) return;
    e.preventDefault();
    // From the focused card (the tab stop), which before a pick is the first, not a checked one.
    const radios = [...(ref.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const focused = radios.findIndex((r) => r === e.target);
    const from =
      focused === -1
        ? Math.max(
            0,
            options.findIndex((o) => o.value === value),
          )
        : focused;
    const next = (from + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    radios[next]?.focus();
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      aria-disabled={disabled || undefined}
      className={className}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => (
        <OptionCard
          key={o.value}
          label={o.label}
          selected={o.value === value}
          disabled={disabled}
          tabIndex={o.value === tabStop ? 0 : -1}
          onSelect={() => onChange(o.value)}
        />
      ))}
    </div>
  );
}
