// The Free/Stakes mode toggle (Paper Components › Actions › Mode toggle; Design_Language.md: boolean
// choices use the two-option segment, there is no switch). A 48px segmented pill; the active mode fills
// with ink and gets a 16px check in the label colour, so the mode never relies on colour alone. It is
// also the leaderboard mode filter.
//
// Semantics: a `radiogroup` of two `radio` buttons, not a tablist. It sets a value (which mode the
// screen shows, or which board is filtered) rather than switching between tab panels the toggle owns:
// on Today the mode changes the stake selector, the CTA and the result together, and on Boards it
// filters a list that the board tabs already own, so there is no single panel for `aria-controls`.
// Keyboard follows the radio pattern: one tab stop (the active mode), arrow keys switch and move focus.
//
// When Stakes isn't offered (region, age or self-exclusion) the toggle becomes a static "Free" label:
// not a control, so a line border instead of ink, and no explanation.
import { useRef, type KeyboardEvent } from 'react';
import { CheckIcon } from './icons/CheckIcon';
import s from './ModeToggle.module.css';

export type Mode = 'free' | 'stakes';

const MODES: readonly { value: Mode; label: string }[] = [
  { value: 'free', label: 'Free' },
  { value: 'stakes', label: 'Stakes' },
];

export interface ModeToggleProps {
  value: Mode;
  onChange: (mode: Mode) => void;
  /** False hides Stakes: the toggle becomes a static "Free" label. */
  stakesAvailable?: boolean;
  /** The group's accessible name. */
  label?: string;
  className?: string;
}

export function ModeToggle({
  value,
  onChange,
  stakesAvailable = true,
  label = 'Mode',
  className,
}: ModeToggleProps) {
  const ref = useRef<HTMLDivElement>(null);

  if (!stakesAvailable) {
    return (
      <p className={['type-body-strong', s.static, className].filter(Boolean).join(' ')}>Free</p>
    );
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    // Two options: any arrow moves to the other one.
    const next = MODES.findIndex((m) => m.value !== value);
    const mode = MODES[next];
    if (!mode) return;
    onChange(mode.value);
    ref.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className={[s.toggle, className].filter(Boolean).join(' ')}
      onKeyDown={onKeyDown}
    >
      {MODES.map((m) => {
        const checked = m.value === value;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={`${checked ? 'type-body-strong' : `type-body ${s.restLabel}`} ${s.segment}`}
            onClick={() => {
              if (!checked) onChange(m.value);
            }}
          >
            {checked ? <CheckIcon width={16} height={16} strokeWidth={2.2} /> : null}
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
