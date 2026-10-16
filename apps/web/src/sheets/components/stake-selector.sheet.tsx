// Components › Stake selector (Paper `components/stake-selector/{light,dark}/desktop`, sheet 3 of 9):
// Free's presets and slider (preset picked, slider between presets, low balance) and Stakes' fixed
// stake (fixed, over the daily cap), each drawn by the real `StakeSelector`.
import type { ReactNode } from 'react';
import { ComponentSheet, SheetSectionHead } from '../SheetChrome';
import type { SheetDef, SheetTheme } from '../types';
import { StakeSelector } from '../../ui/StakeSelector';
import s from './stake-selector.module.css';

const noop = () => undefined;

function State({ name, note, children }: { name: string; note: string; children: ReactNode }) {
  return (
    <div className={s.column}>
      <h3 className="type-body-strong">{name}</h3>
      {children}
      <p className={s.note}>{note}</p>
    </div>
  );
}

function StakeSelectorSheet({ theme }: { theme: SheetTheme }) {
  return (
    <ComponentSheet
      theme={theme}
      index={3}
      title="Stake selector"
      intro="Free lets you choose how many points to risk: four presets or the slider, 10 to 100. Stakes has nothing to choose. Every entry in a round pays the same fixed stake."
    >
      <section className={s.section}>
        <SheetSectionHead
          title="Free: presets and slider"
          note="Points, 10 to 100. Presets and slider set the same value."
        />
        <div className={s.row}>
          <State
            name="Preset picked"
            note="Value in numberXL. Active preset fills with ink. 40px chips; the whole slider row is a 44px target."
          >
            <StakeSelector mode="free" value={25} onChange={noop} />
          </State>
          <State
            name="Slider, between presets"
            note="Dragging clears the preset. Steps of 1. Arrow keys move 1, Page Up and Page Down move 10."
          >
            <StakeSelector mode="free" value={63} onChange={noop} />
          </State>
          <State
            name="Low balance"
            note="Balance 40 points. Presets above it are disabled and the slider stops at the balance. The daily grant tops it up."
          >
            <StakeSelector mode="free" value={40} balance={40} onChange={noop} />
          </State>
        </div>
      </section>
      <section className={`${s.section} ${s.ruled}`}>
        <SheetSectionHead
          title="Stakes: fixed stake"
          note="Read-only. Frozen when the question locks; default 5 USDC."
        />
        <div className={s.row}>
          <State
            name="Fixed"
            note="Not a control, so a line border on surface. Whole USDC shows no decimals; a stake with cents shows two (2.50 USDC)."
          >
            <StakeSelector mode="stakes" stake={5_000_000n} />
          </State>
          <State
            name="Over the daily cap"
            note="Checked at ticket issue. The amount goes muted and the CTA is disabled. The cap is per game day."
          >
            <StakeSelector mode="stakes" stake={5_000_000n} dailyCap={100_000_000n} overCap />
          </State>
        </div>
      </section>
    </ComponentSheet>
  );
}

const sheet: SheetDef = {
  name: 'components/stake-selector',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <StakeSelectorSheet theme={state === 'dark' ? 'dark' : 'light'} />,
};

export default sheet;
