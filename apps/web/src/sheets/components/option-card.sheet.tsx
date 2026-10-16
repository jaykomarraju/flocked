// Components › Option card (Paper `components/option-card/{light,dark}/desktop`, sheet 1 of 9): the
// pick states and the two reveal states, each drawn by the real `OptionCard`.
import { formatShare } from '@flocked/shared';
import type { ReactNode } from 'react';
import { ComponentSheet, SheetSectionHead } from '../SheetChrome';
import type { SheetDef, SheetTheme } from '../types';
import { OptionCard } from '../../ui/OptionCard';
import s from './option-card.module.css';

const LABEL = 'One horse-sized duck';

function State({ name, note, children }: { name: string; note: string; children: ReactNode }) {
  return (
    <div className={s.state}>
      <p className="type-body-strong">{name}</p>
      {children}
      <p className={s.note}>{note}</p>
    </div>
  );
}

function OptionCardSheet({ theme }: { theme: SheetTheme }) {
  return (
    <ComponentSheet
      theme={theme}
      index={1}
      title="Option card"
      intro="The whole card is the tap target. Two per question, stacked full width on mobile. Picking fills it with ink. At the reveal the stray side takes the accent and the flock stays monochrome."
    >
      <section className={s.section}>
        <SheetSectionHead
          title="Before the pick"
          note="Would you rather fight one horse-sized duck or 100 duck-sized horses?"
        />
        <div className={s.row}>
          <State
            name="Idle"
            note="Surface fill, 2px ink border, 16px radius. Label in the option role. 80px tall, grows if the label wraps."
          >
            <OptionCard label={LABEL} />
          </State>
          <State
            name="Hover"
            note="Fill changes to line. Border and label stay. Pointer devices only; motion.micro 175ms."
          >
            <OptionCard label={LABEL} forceState="hover" />
          </State>
          <State
            name="Pressed"
            note="Line fill, scales to 0.97 on press and back on release. motion.press 150ms."
          >
            <OptionCard label={LABEL} forceState="pressed" />
          </State>
        </div>
        <div className={s.row}>
          <State
            name="Selected"
            note="Ink fill, label turns bg. The radio fills with bg and gets a check, so the pick never relies on color alone."
          >
            <OptionCard label={LABEL} selected />
          </State>
          <State
            name="Focus (keyboard)"
            note="The foundation focus ring: 2px ink outline, 3px offset. Shown on focus-visible only. Space or Enter picks."
          >
            <OptionCard label={LABEL} forceState="focus" />
          </State>
          <State
            name="Disabled"
            note="Round closed or already entered. Bg fill, dashed muted border, muted label. Not focusable."
          >
            <OptionCard label={LABEL} disabled />
          </State>
        </div>
      </section>
      <section className={`${s.section} ${s.ruled}`}>
        <SheetSectionHead
          title="At the reveal"
          note="Headcount share in the numberXL role. Fewer people wins."
        />
        <div className={s.row}>
          {/* A 38.6 / 61.4 split: the winner rounds down to 38%, the loser up to 62%. */}
          <State
            name="Revealed, win"
            note="The Strays side. Accent fill; label steps up to the cta role (Fredoka 700) because it sits on the accent."
          >
            <OptionCard label={LABEL} result="win" share={formatShare(386, 1000, 'win')} yourPick />
          </State>
          <State
            name="Revealed, loss"
            note={
              'The Flock side. Monochrome: ink on surface. If it was your pick it gets the same ink "Your pick" pill.'
            }
          >
            <OptionCard
              label="100 duck-sized horses"
              result="loss"
              share={formatShare(614, 1000, 'loss')}
            />
          </State>
          <aside className={s.rounding}>
            <p className={`type-label ${s.roundingTitle}`}>Rounding (Decision log, Oct 7)</p>
            <p className={s.roundingBody}>
              Whole percent. The winning share rounds down and the losing share rounds up, so a
              winner never reads 50%. A 38.6 / 61.4 split shows 38% and 62%. At the extremes: &lt;1%
              and &gt;99%.
            </p>
          </aside>
        </div>
      </section>
    </ComponentSheet>
  );
}

const sheet: SheetDef = {
  name: 'components/option-card',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <OptionCardSheet theme={state as SheetTheme} />,
};

export default sheet;
