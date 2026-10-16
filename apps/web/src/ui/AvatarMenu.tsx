// The header's avatar menu (spec "Client app" › Navigation): from tablet up, Submit, Queue, Claims and
// Settings sit here (the same list as the mobile You sheet), plus "Sign out". A menu button: Enter,
// Space or ArrowDown opens it on the first item, ArrowUp on the last; arrows, Home and End move
// between items; Escape closes it and returns focus to the avatar; Tab or a click outside closes it.
// No artboard draws it: it follows the kit (surface panel, 2px ink border, radius 16, label-role items
// 40 tall, hover = line fill).
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { YOU_LINKS } from '../nav';
import { Avatar } from './Avatar';
import s from './AvatarMenu.module.css';

export interface AvatarMenuProps {
  /** The signed-in handle: the avatar's fallback letter. */
  handle: string;
  /** The profile picture URL. */
  avatarUrl?: string | null;
  onSignOut: () => void;
  /** Starts open (design sheets). */
  defaultOpen?: boolean;
}

type Focus = 'first' | 'last' | null;

export function AvatarMenu({ handle, avatarUrl, onSignOut, defaultOpen = false }: AvatarMenuProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [focusOnOpen, setFocusOnOpen] = useState<Focus>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const buttonId = useId();

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const show = (focus: Focus) => {
    setFocusOnOpen(focus);
    setOpen(true);
  };

  // Move focus into the menu once it has rendered.
  useEffect(() => {
    if (!open || focusOnOpen === null) return;
    const list = items();
    (focusOnOpen === 'first' ? list[0] : list[list.length - 1])?.focus();
    setFocusOnOpen(null);
  }, [open, focusOnOpen]);

  // A press outside closes the menu (focus stays where the press put it).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      show(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(index + 1);
      case 'ArrowUp':
        return move(index < 0 ? -1 : index - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(-1);
      case 'Escape':
        event.preventDefault();
        return close(true);
      case 'Tab':
        return close(false);
    }
  };

  return (
    <div ref={rootRef} className={s.root}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className={s.button}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : show('first'))}
        onKeyDown={onButtonKeyDown}
      >
        <Avatar handle={handle} size={32} src={avatarUrl} className={s.avatar} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={buttonId}
          className={s.menu}
          onKeyDown={onMenuKeyDown}
        >
          {YOU_LINKS.map((link) => (
            <Link
              key={link.id}
              to={link.path}
              role="menuitem"
              tabIndex={-1}
              className={`type-label ${s.item}`}
              onClick={() => close(false)}
            >
              {link.label}
            </Link>
          ))}
          <div role="separator" className={s.rule} />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`type-label ${s.item}`}
            onClick={() => {
              close(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
