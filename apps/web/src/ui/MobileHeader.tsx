// The mobile header (Paper Components › Navigation › "Header (mobile)"): the wordmark, then the
// balance slot and the avatar, or the "Sign in" pill when signed out. The avatar opens You (the same
// sheet as the You tab). 56 tall on bg with a line divider; it doesn't stick on Today, where the
// question owns the top of the screen (the shell decides that).
import { Avatar } from './Avatar';
import { BalanceSlot, type Balance } from './BalanceSlot';
import { Button } from './Button';
import type { HeaderUser } from './Header';
import { Wordmark } from './Wordmark';
import s from './MobileHeader.module.css';

export interface MobileHeaderProps {
  /** The signed-in account, or null for the "Sign in" pill. */
  user: HeaderUser | null;
  /** The balance slot (signed in only). */
  balance?: Balance | null;
  onSignIn: () => void;
  /** The avatar: opens the You sheet. */
  onYou: () => void;
  /** Whether the You sheet is open (the avatar's `aria-expanded`). */
  youOpen?: boolean;
}

export function MobileHeader({
  user,
  balance,
  onSignIn,
  onYou,
  youOpen = false,
}: MobileHeaderProps) {
  return (
    <header className={s.header}>
      <Wordmark size="mobile" />
      {user ? (
        <div className={s.account}>
          {balance ? <BalanceSlot balance={balance} size="mobile" /> : null}
          <button
            type="button"
            className={s.avatarButton}
            aria-label="Your account"
            aria-haspopup="dialog"
            aria-expanded={youOpen}
            onClick={onYou}
          >
            <Avatar handle={user.handle} size={32} src={user.avatarUrl} className={s.avatar} />
          </button>
        </div>
      ) : (
        <Button variant="secondary" size="small" onClick={onSignIn}>
          Sign in
        </Button>
      )}
    </header>
  );
}
