// The frame every Components-page sheet shares (Paper: an artboard 1120 wide, padding 64, gap 40, on
// bg): the "Flocked · Components · n of 9" header with the sheet title and its intro, and the section
// heads ("Before the pick" + a note). Sheets put their rows in between.
import type { ReactNode } from 'react';
import type { SheetTheme } from './types';
import s from './SheetChrome.module.css';

export function ComponentSheet({
  theme,
  index,
  title,
  intro,
  children,
}: {
  theme: SheetTheme;
  /** The sheet's place on the Components page, 1 to 9. */
  index: number;
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-theme={theme} className={s.artboard}>
      <header className={s.header}>
        <div className={s.titles}>
          <p className={s.kicker}>Flocked · Components · {index} of 9</p>
          <h1 className={s.title}>{title}</h1>
        </div>
        <p className={`type-body ${s.intro}`}>{intro}</p>
      </header>
      {children}
    </div>
  );
}

/** A section head: the title role and a label-role note on one baseline. */
export function SheetSectionHead({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div className={s.sectionHead}>
      <h2 className="type-title">{title}</h2>
      {note ? <p className="type-label">{note}</p> : null}
    </div>
  );
}
