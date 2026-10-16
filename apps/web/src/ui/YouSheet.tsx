// The You sheet (spec "Client app" › Navigation): on mobile the You tab (and the header's avatar)
// toggles it. The same list as the avatar menu from tablet up: Submit, Queue, Claims and Settings,
// plus "Sign out", in a `BottomSheet`. Choosing a destination closes it; so do "Not now" (the
// convention for optional sheets), the scrim, the handle and Escape.
import { Link } from 'react-router';
import { YOU_LINKS } from '../nav';
import { BottomSheet, DialogTitle } from './BottomSheet';
import { TextButton } from './TextButton';
import s from './YouSheet.module.css';

export interface YouSheetProps {
  open: boolean;
  onClose: () => void;
  onSignOut: () => void;
  /** The list's id: the You tab's `aria-controls`. */
  id?: string;
  /** Render in place (design sheets). */
  inline?: boolean;
}

export function YouSheet({ open, onClose, onSignOut, id, inline }: YouSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} inline={inline}>
      <DialogTitle className="type-title">You</DialogTitle>
      <nav id={id} aria-label="You" className={s.list}>
        <ul>
          {YOU_LINKS.map((link) => (
            <li key={link.id}>
              <Link to={link.path} className={`type-body ${s.item}`} onClick={onClose}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className={s.rule} />
        <button
          type="button"
          className={`type-body ${s.item}`}
          onClick={() => {
            onClose();
            onSignOut();
          }}
        >
          Sign out
        </button>
      </nav>
      <TextButton onClick={onClose}>Not now</TextButton>
    </BottomSheet>
  );
}
