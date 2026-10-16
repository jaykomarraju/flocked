// The `notes (not part of the screen)` band that ends the Reveal artboards (docs/design/screens.md,
// "Core flow decisions (W3-C.2)"): a surface band under the screen with a 2px dashed muted top border,
// a 600 title and numbered notes, and on refund a second section (a line rule, then its own title and
// lines). It is part of the Paper export, so the sheet draws it; the app never does.
import type { SheetBreakpoint } from '../types';
import s from './NotesBand.module.css';

export interface NotesSection {
  title: string;
  lines: readonly string[];
}

export interface NotesBandProps {
  breakpoint: SheetBreakpoint;
  title: string;
  notes: readonly string[];
  /** A second section under a line rule (the refund lines). */
  more?: NotesSection;
}

export function NotesBand({ breakpoint, title, notes, more }: NotesBandProps) {
  return (
    <aside
      className={s.band}
      data-breakpoint={breakpoint}
      aria-label="Notes (not part of the screen)"
    >
      <p className={s.title}>{title}</p>
      {notes.map((note) => (
        <p key={note} className={s.note}>
          {note}
        </p>
      ))}
      {more ? (
        <div className={s.more}>
          <p className={s.title}>{more.title}</p>
          {more.lines.map((line) => (
            <p key={line} className={s.note}>
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
