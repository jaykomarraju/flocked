// The stake selector (Paper Components › Stake selector).
//
// Free: how many points to risk, 10 to 100 by default. The value in numberXL, four 40px preset chips
// (a radio group: the picked one fills with ink, bg label) and a slider (a real range input; the whole
// row is a 44px target). Presets and slider set the same value; dragging between presets leaves no
// preset picked. Steps of 1; arrow keys move 1, Page Up and Page Down move 10. With a low balance the
// presets above it are disabled and the slider stops at the balance.
//
// Stakes: nothing to choose. A read-only box (line border on surface, since it is not a control) shows
// the round's fixed stake, "Same for everyone". Over the daily cap the amount goes muted, the cap
// replaces "Same for everyone" and the cap line follows (the screen disables the CTA).
import { VOICE } from '@flocked/shared';
import { useId, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatUsdc, groupDigits } from './amounts';
import { PadlockIcon } from './icons/PadlockIcon';
import s from './StakeSelector.module.css';

/** Free-mode defaults (Paper; the round's locked config can override them). */
export const FREE_STAKE_MIN = 10;
export const FREE_STAKE_MAX = 100;
export const FREE_STAKE_PRESETS: readonly number[] = [10, 25, 50, 100];
/** Page Up and Page Down move the slider this far. */
export const FREE_STAKE_PAGE_STEP = 10;

export interface FreeStakeSelectorProps {
  mode: 'free';
  /** The stake in points. */
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  presets?: readonly number[];
  /** The player's points balance. Below `max`, presets above it are disabled and the slider stops at it. */
  balance?: number;
  className?: string;
}

export interface StakesStakeSelectorProps {
  mode: 'stakes';
  /** The round's fixed stake in USDC base units. */
  stake: bigint;
  /** Today's cap in USDC base units, shown when the player is over it. */
  dailyCap?: bigint;
  /** The entry would pass today's cap: the amount goes muted and the cap line shows. */
  overCap?: boolean;
  className?: string;
}

export type StakeSelectorProps = FreeStakeSelectorProps | StakesStakeSelectorProps;

export function StakeSelector(props: StakeSelectorProps) {
  return props.mode === 'free' ? <FreeStake {...props} /> : <FixedStake {...props} />;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function FreeStake({
  value,
  onChange,
  min = FREE_STAKE_MIN,
  max = FREE_STAKE_MAX,
  presets = FREE_STAKE_PRESETS,
  balance,
  className,
}: FreeStakeSelectorProps) {
  const sliderId = useId();
  const balanceId = useId();
  const presetRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // The most the player can stake: the range's top, or their balance when it is lower.
  const limit = balance === undefined ? max : Math.min(max, balance);
  const sliderMax = Math.max(min, limit);
  const lowBalance = limit < max;
  const frac = sliderMax > min ? clamp((value - min) / (sliderMax - min), 0, 1) : 1;

  const enabled = presets.map((p) => p <= limit);
  const checkedIndex = presets.findIndex((p, i) => p === value && enabled[i]);
  // Roving tabindex: the picked preset, else the first enabled one, is the group's tab stop.
  const tabStop = checkedIndex >= 0 ? checkedIndex : enabled.indexOf(true);

  const set = (v: number) => onChange(clamp(v, min, sliderMax));

  function onPresetKey(e: ReactKeyboardEvent<HTMLButtonElement>, i: number) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const n = presets.length;
    for (let k = 1; k <= n; k++) {
      const j = (((i + step * k) % n) + n) % n;
      if (enabled[j]) {
        onChange(presets[j]!);
        presetRefs.current[j]?.focus();
        return;
      }
    }
  }

  function onSliderKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
    e.preventDefault();
    set(value + (e.key === 'PageUp' ? FREE_STAKE_PAGE_STEP : -FREE_STAKE_PAGE_STEP));
  }

  return (
    <div className={className ? `${s.free} ${className}` : s.free}>
      <div className={s.head}>
        <label htmlFor={sliderId} className="type-label">
          Stake
        </label>
        <p className={s.value}>
          <span className="type-number-xl">{groupDigits(value)}</span>
          <span className="type-label">points</span>
        </p>
      </div>
      <div role="radiogroup" aria-label="Stake presets" className={s.presets}>
        {presets.map((p, i) => (
          <button
            key={p}
            ref={(el) => {
              presetRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={i === checkedIndex}
            disabled={!enabled[i]}
            tabIndex={i === tabStop ? 0 : -1}
            className={`type-number ${s.preset}`}
            onClick={() => onChange(p)}
            onKeyDown={(e) => onPresetKey(e, i)}
          >
            {groupDigits(p)}
          </button>
        ))}
      </div>
      <div className={s.range}>
        <div className={s.slider} style={{ '--frac': frac } as CSSProperties}>
          <div className={s.fill} />
          <div className={s.thumb} />
          <div className={s.rest} />
          <input
            id={sliderId}
            type="range"
            className={s.input}
            min={min}
            max={sliderMax}
            step={1}
            value={value}
            disabled={limit < min}
            aria-valuetext={`${groupDigits(value)} points`}
            aria-describedby={lowBalance ? balanceId : undefined}
            onChange={(e) => set(Number(e.currentTarget.value))}
            onKeyDown={onSliderKey}
          />
        </div>
        <div className={`type-caption tnum ${s.ends}`}>
          <span>{groupDigits(min)}</span>
          <span id={balanceId}>
            {lowBalance ? `${groupDigits(sliderMax)}, your balance` : groupDigits(max)}
          </span>
        </div>
      </div>
    </div>
  );
}

function FixedStake({ stake, dailyCap, overCap = false, className }: StakesStakeSelectorProps) {
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={className ? `${s.fixed} ${className}` : s.fixed}
    >
      <div className={s.fixedHead}>
        <span id={labelId} className="type-label">
          Stake
        </span>
        {overCap ? (
          dailyCap !== undefined && (
            <span className="type-label">Cap {formatUsdc(dailyCap)} USDC a day</span>
          )
        ) : (
          <span className={s.same}>
            <PadlockIcon className={s.icon} />
            <span className="type-label">Same for everyone</span>
          </span>
        )}
      </div>
      <p className={s.value}>
        <span className="type-number-xl" data-muted={overCap ? 'true' : undefined}>
          {formatUsdc(stake)}
        </span>
        <span className="type-body-strong">USDC</span>
      </p>
      {overCap && <p className={s.capLine}>{VOICE.dailyCap}</p>}
    </div>
  );
}
