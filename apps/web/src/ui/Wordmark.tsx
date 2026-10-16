// The wordmark (Paper Components › Navigation): "Flocked" in Fredoka 700, never the accent, as a
// link home. 24px with -0.01em tracking in the desktop header, 22px in the mobile header.
import { Link } from 'react-router';
import s from './Wordmark.module.css';

export function Wordmark({ size = 'desktop' }: { size?: 'mobile' | 'desktop' }) {
  return (
    <Link to="/" aria-label="Flocked home" className={s.wordmark} data-size={size}>
      Flocked
    </Link>
  );
}
