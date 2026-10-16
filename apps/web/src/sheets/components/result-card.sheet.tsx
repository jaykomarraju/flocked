// Components › Result card (Paper `components/result-card/{light,dark}/desktop`, sheet 5 of 9): the
// four results, each drawn by the real `ResultCard`.
import type { ReactNode } from 'react';
import { ComponentSheet } from '../SheetChrome';
import type { SheetDef, SheetTheme } from '../types';
import { ResultCard } from '../../ui/ResultCard';
import s from './result-card.module.css';

function State({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return (
    <div className={s.state}>
      <p className="type-body-strong">{label}</p>
      {children}
      <p className={s.note}>{note}</p>
    </div>
  );
}

function ResultCardSheet({ theme }: { theme: SheetTheme }) {
  return (
    <ComponentSheet
      theme={theme}
      index={5}
      title="Result card"
      intro="Springs up from the bottom after the bars settle (motion.spring). The result line is the only all-caps text in the product. Winning gets the accent; everything else stays ink."
    >
      <div className={s.row}>
        <State
          label="Unflocked (Free)"
          note="Result line in the result role, accent (28px clears the large-text rule). Voice line is winLine(38): the winning share rounds down. Smug sheep."
        >
          {/* 38.6% of the entries: the winning share rounds down to 38%. */}
          <ResultCard
            result="unflocked"
            count={386}
            total={1000}
            stake="25 points"
            figure={{ label: 'Won', value: '+38 points' }}
          />
        </State>
        <State
          label="Got flocked (Free)"
          note="Monochrome. Voice line is lossLine(62): the losing share rounds up, so 38.6 / 61.4 reads 38% and 62%. Shocked sheep; the flock slides in behind the card on mobile."
        >
          <ResultCard
            result="got-flocked"
            count={614}
            total={1000}
            stake="25 points"
            figure={{ label: 'Lost', value: '−25 points' }}
          />
        </State>
      </div>
      <div className={s.row}>
        <State
          label="Refunded"
          note="Sentence case, ink, neutral sheep. One line per refund reason; shown: rule 3 (tie). Others: too few people, one side empty, voided, timed out. Copy is a proposal (not in Design_Language)."
        >
          <ResultCard
            result="refunded"
            stake="25 points"
            figure={{ label: 'Returned', value: '25 points' }}
          />
        </State>
        <State
          label="Unflocked, provisional (Stakes)"
          note={
            'Stakes results show as soon as the proposal confirms, with the challenge-window end as "Final at". At final the chip goes away and Claims opens. A Stakes refund is provisional the same way. A guardian veto re-renders the card as refunded.'
          }
        >
          <ResultCard
            result="unflocked"
            count={386}
            total={1000}
            stake="5 USDC"
            figure={{ label: 'Payout, once final', value: '12.67 USDC' }}
            finalAt="11:03pm"
          />
        </State>
      </div>
    </ComponentSheet>
  );
}

const sheet: SheetDef = {
  name: 'components/result-card',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <ResultCardSheet theme={state === 'dark' ? 'dark' : 'light'} />,
};

export default sheet;
