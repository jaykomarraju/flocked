// The share-card preview and the Share button on the reveal (Paper `core/reveal/{win,loss,refund}/*`,
// `share`): a small copy of the result card W10-A renders (question, the mini split, the result word,
// "@handle · Flocked", the sheep) on a bg card 232 tall on mobile and 300 from tablet up, then Share,
// the screen's one accent action. Share uses the system share sheet when there is one, else copies the
// link.
import { BRAND, type MascotPose } from '@flocked/shared';
import { Mascot } from '@flocked/shared/mascot/react';
import type { Breakpoint } from '../../theme';
import { Button } from '../../ui/Button';
import { splitFillWidth } from '../../ui/SplitBars';
import s from './ShareBlock.module.css';

export interface ShareBlockProps {
  question: string;
  counts: readonly [number, number];
  winner: number | null;
  result: 'unflocked' | 'got-flocked' | 'refunded';
  handle: string | null;
  url: string;
  /** The preview's size: small on mobile (the default), larger from tablet up. */
  breakpoint?: Breakpoint;
}

const POSE: Record<ShareBlockProps['result'], MascotPose> = {
  unflocked: 'smug',
  'got-flocked': 'shocked',
  refunded: 'neutral',
};

export async function shareLink(url: string, title: string): Promise<void> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ url, title });
      return;
    } catch {
      // Dismissed or refused: fall back to copying.
    }
  }
  await navigator.clipboard?.writeText(url);
}

export function ShareBlock({
  question,
  counts,
  winner,
  result,
  handle,
  url,
  breakpoint = 'mobile',
}: ShareBlockProps) {
  const total = counts[0] + counts[1];
  const word =
    result === 'unflocked'
      ? BRAND.unflocked
      : result === 'got-flocked'
        ? BRAND.gotFlocked
        : 'Refunded';
  return (
    <div className={s.block} data-breakpoint={breakpoint}>
      <figure className={s.preview} aria-label="Share card preview">
        <p className={s.question}>{question}</p>
        <div className={s.bars} aria-hidden="true">
          {counts.map((c, i) => (
            <div key={i} className={s.track}>
              <div
                className={s.fill}
                data-winner={winner === i ? 'true' : undefined}
                style={{ width: splitFillWidth(c, total) }}
              />
            </div>
          ))}
        </div>
        <div className={s.foot}>
          <div className={s.who}>
            <p className={s.word} data-result={result}>
              {word}
            </p>
            <p className={s.handle}>{handle ? `@${handle} · Flocked` : 'Flocked'}</p>
          </div>
          <Mascot
            pose={POSE[result]}
            size={breakpoint === 'mobile' ? 56 : 72}
            className={s.sheep}
          />
        </div>
      </figure>
      <Button onClick={() => void shareLink(url, question)}>Share</Button>
    </div>
  );
}
