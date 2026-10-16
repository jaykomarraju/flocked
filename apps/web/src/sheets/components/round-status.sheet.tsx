// Components › Round status (Paper `components/round-status/{light,dark}/desktop`, sheet 4 of 9): the
// countdown, the entrant and pool counter, the sealed badge and the locked pick while the round is open,
// then the split bars (start, settled, tie, extreme), each drawn by the real component.
import type { ReactNode } from 'react';
import { ComponentSheet, SheetSectionHead } from '../SheetChrome';
import type { SheetDef, SheetTheme } from '../types';
import { Countdown } from '../../ui/Countdown';
import { EntrantCounter } from '../../ui/EntrantCounter';
import { SealedBadge } from '../../ui/SealedBadge';
import { SealedPick } from '../../ui/SealedPick';
import { SplitBars } from '../../ui/SplitBars';
import s from './round-status.module.css';

const OPTIONS = ['One horse-sized duck', '100 duck-sized horses'] as const;

/** 04:12:37 and 00:00:42. */
const CLOSES_IN_MS = (4 * 3600 + 12 * 60 + 37) * 1000;
const REVEAL_IN_MS = 42 * 1000;

function State({
  name,
  note,
  wide = false,
  children,
}: {
  name: string;
  note: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? s.columnWide : s.column}>
      <h3 className="type-body-strong">{name}</h3>
      {children}
      <p className={s.note}>{note}</p>
    </div>
  );
}

function RoundStatusSheet({ theme }: { theme: SheetTheme }) {
  return (
    <ComponentSheet
      theme={theme}
      index={4}
      title="Round status"
      intro="What the round is doing: time left, how many people are in, whether your pick is sealed, and at the reveal, how the crowd split. Numbers use tabular figures so they don't jitter as they tick."
    >
      <section className={s.section}>
        <SheetSectionHead title="While the round is open" />
        <div className={s.row}>
          <State
            name="Countdown"
            note={
              'hh:mm:ss in numberXL. Today counts to close, Sealed to the reveal. Under an hour it keeps the 00 so the width never shifts. One exception: the unsealing countdown after close is m:ss ("Unsealing in 1:42"), because the beacon delay is at most 600 s, so it never passes 10:00.'
            }
          >
            <Countdown label="Closes in" remainingMs={CLOSES_IN_MS} />
            <Countdown label="Reveal in" remainingMs={REVEAL_IN_MS} />
          </State>
          <State
            name="Entrant and pool counter"
            note="Number role. Free counts points, Stakes counts USDC. The dot marks a live value; it doesn't blink. Never shows the split before the reveal."
          >
            <EntrantCounter mode="free" entrants={1204} pool={30_100n} live />
            <EntrantCounter mode="stakes" entrants={212} pool={1_060_000_000n} live />
          </State>
          <State
            name="Padlock sealed badge"
            note={
              'The badge marks a sealed entry anywhere. On Sealed, the locked pick keeps the ink fill with a padlock in the radio slot, plus the stake. Voice: "Your pick is sealed. Nobody can see it. Not even us."'
            }
          >
            <SealedBadge />
            <SealedPick option={OPTIONS[0]} mode="free" stake={25n} />
          </State>
        </div>
      </section>
      <section className={`${s.section} ${s.ruled}`}>
        <SheetSectionHead
          title="Split bars"
          note="Start equal, grow to headcount shares over 3s (motion.reveal), then the winner fills with the accent."
        />
        <div className={s.row}>
          <State
            wide
            name="Start: equal, unsealing"
            note="Both bars at half, in ink, with no numbers. Track in line (decoration only). Reduced motion skips straight to the end state with a fade."
          >
            <SplitBars options={OPTIONS} />
          </State>
          <State
            wide
            name="End: settled, win accent"
            note="Fewer people wins, so the shorter bar gets the accent. Percentages stay ink (accent text needs 24px). Same rounding as the option card."
          >
            <SplitBars options={OPTIONS} counts={[38, 62]} winner={0} />
          </State>
        </div>
        <div className={`${s.row} ${s.rowLower}`}>
          <State
            wide
            name="End: headcount tie, refunded"
            note="No winner, so no accent. An exact tie is the only time either side reads 50%."
          >
            <SplitBars options={OPTIONS} counts={[50, 50]} winner={null} />
          </State>
          <State
            wide
            name="End: extreme split"
            note="A fill never drops below 24px (one full round end), so a tiny winning side stays visible. Labels read <1% and >99%."
          >
            <SplitBars options={OPTIONS} counts={[1, 250]} winner={0} />
          </State>
        </div>
      </section>
    </ComponentSheet>
  );
}

const sheet: SheetDef = {
  name: 'components/round-status',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <RoundStatusSheet theme={state === 'dark' ? 'dark' : 'light'} />,
};

export default sheet;
