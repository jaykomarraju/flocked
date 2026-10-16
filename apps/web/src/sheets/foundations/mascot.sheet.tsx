// Foundations › "The sheep" (Paper `foundations/mascot/{light,dark}/desktop`; Design_Language.md
// "Mascot"): the five placeholder poses, each drawn by the shared `Mascot` component.
import type { MascotPose } from '@flocked/shared';
import { Mascot } from '@flocked/shared/mascot/react';
import type { SheetDef, SheetTheme } from '../types';
import s from './mascot.module.css';

const POSES: { pose: MascotPose; name: string; note: string }[] = [
  {
    pose: 'neutral',
    name: 'Neutral',
    note: 'Default. Half-closed eyes, slight smirk. Empty and loading states.',
  },
  { pose: 'smug', name: 'Smug', note: 'Win. Chin up, wider smirk, one accent glint.' },
  {
    pose: 'walking-away',
    name: 'Walking away',
    note: 'Win animation. Alone, mid-stride, off-screen right.',
  },
  { pose: 'shocked', name: 'Shocked', note: 'Loss. Eyes open for once. Ears up.' },
];

const INTRO: Record<SheetTheme, string> = {
  light:
    'One smug, unbothered sheep: ink outlines, white wool, so it reads as a sticker on any ground. ' +
    'Accent only on the win pose.',
  dark:
    'Same sheep, same ink outline and white wool. In dark mode, strokes outside the wool (legs, ' +
    'motion and shock lines) switch to dark ink so they stay visible.',
};

function MascotSheet({ theme }: { theme: SheetTheme }) {
  return (
    <div data-theme={theme} className={s.artboard}>
      <header className={s.header}>
        <div className={s.titles}>
          <p className={s.kicker}>
            Flocked · Foundations · placeholder art{theme === 'dark' ? ' · dark' : ''}
          </p>
          <h1 className={s.title}>The sheep</h1>
        </div>
        <p className={`type-body ${s.intro}`}>{INTRO[theme]}</p>
      </header>
      <div className={s.poses}>
        {POSES.map(({ pose, name, note }) => (
          <section key={pose} className={s.card}>
            <Mascot pose={pose} size={176} className={s.sheep} />
            <h2 className="type-option">{name}</h2>
            <p className={s.note}>{note}</p>
          </section>
        ))}
      </div>
      <section className={s.flockCard}>
        <Mascot pose="flock" size={560} className={s.sheep} />
        <div className={s.flockText}>
          <h2 className="type-option">Flock</h2>
          <p className={s.note}>
            The &quot;got flocked&quot; state. Identical sheep, same expression, bunched together.
            On loss they slide in from the side (motion.flock).
          </p>
        </div>
      </section>
    </div>
  );
}

const sheet: SheetDef = {
  name: 'foundations/mascot',
  artboards: ['light/desktop', 'dark/desktop'],
  render: (state) => <MascotSheet theme={state === 'dark' ? 'dark' : 'light'} />,
};

export default sheet;
