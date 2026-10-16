// The result card (Paper Components › Result card): the player's result after the reveal. It springs
// up from the bottom once the bars settle (motion.spring, owned by the screen that shows it).
//   unflocked    "UNFLOCKED" in the result role and the accent, winLine, the smug sheep
//   got-flocked  "GOT FLOCKED" in ink, lossLine, the shocked sheep (losing stays monochrome)
//   refunded     "Refunded" in ink, sentence case, a refund line (default: the tie), the neutral sheep
// A Stakes result shows as soon as the proposal confirms, with a "Final at" chip until the challenge
// window ends. UNFLOCKED and GOT FLOCKED are the only all-caps lines in the product; they are the brand
// terms uppercased in CSS, so assistive tech reads the words rather than spelling them out.
import { BRAND, VOICE, lossLine, winLine, type MascotPose } from '@flocked/shared';
import { Mascot } from '@flocked/shared/mascot/react';
import { useId } from 'react';
import { ClockIcon } from './icons/ClockIcon';
import s from './ResultCard.module.css';

export type ResultKind = 'unflocked' | 'got-flocked' | 'refunded';

/** A labelled amount under the result: "Stake / 25 points", "Won / +38 points". */
export interface ResultFigure {
  label: string;
  value: string;
}

export type ResultCardProps = {
  /** What the player put in, as shown ("25 points", "5 USDC"). */
  stake: string;
  /** The second figure: "Won", "Lost", "Returned", "Payout, once final". */
  figure: ResultFigure;
  /** Stakes before final: the challenge-window end as shown ("11:03pm"). Omit once final. */
  finalAt?: string;
  className?: string;
} & (
  | {
      result: 'unflocked' | 'got-flocked';
      /** Valid entries on the player's side. */
      count: number;
      /** All valid entries. */
      total: number;
    }
  | {
      result: 'refunded';
      /** The refund reason's line (Design_Language.md "Voice"); defaults to the tie. */
      line?: string;
    }
);

const POSE: Record<ResultKind, MascotPose> = {
  unflocked: 'smug',
  'got-flocked': 'shocked',
  refunded: 'neutral',
};

const HEADLINE: Record<ResultKind, string> = {
  unflocked: BRAND.unflocked,
  'got-flocked': BRAND.gotFlocked,
  refunded: 'Refunded',
};

export function ResultCard(props: ResultCardProps) {
  const { result, stake, figure, finalAt, className } = props;
  const headingId = useId();
  const line =
    props.result === 'refunded'
      ? (props.line ?? VOICE.refundedTie)
      : props.result === 'unflocked'
        ? winLine(props.count, props.total)
        : lossLine(props.count, props.total);

  return (
    <section
      className={className ? `${s.card} ${className}` : s.card}
      aria-labelledby={headingId}
      data-result={result}
    >
      <div className={s.top}>
        <div className={s.text}>
          <h2 id={headingId} className={`type-result ${s.headline}`} data-result={result}>
            {HEADLINE[result]}
          </h2>
          <p className="type-body">{line}</p>
        </div>
        <Mascot pose={POSE[result]} size={104} className={s.sheep} />
      </div>
      {finalAt !== undefined && (
        <p className={s.finalAt}>
          <ClockIcon className={s.clock} />
          <span className="type-label">Provisional. Final at {finalAt}</span>
        </p>
      )}
      <dl className={s.figures}>
        <div className={s.figure}>
          <dt className="type-label">Stake</dt>
          <dd className="type-number">{stake}</dd>
        </div>
        <div className={s.figure}>
          <dt className="type-label">{figure.label}</dt>
          <dd className="type-body-strong tnum">{figure.value}</dd>
        </div>
      </dl>
    </section>
  );
}
