// The verify callout on Today (Paper `core/today/open-stakes-unverified/*`): an unverified player
// still sees Stakes (spec "Client app" › Today), with this where the stake selector would be and
// "Verify with Coinbase" as the CTA. Read-only, so it uses the 1.5px line border, not the ink one.
import { ShieldCheckIcon } from './ShieldCheckIcon';
import { VERIFY_CALLOUT } from './copy';
import s from './VerifyCallout.module.css';

export function VerifyCallout() {
  return (
    <div className={s.callout} role="note">
      <ShieldCheckIcon className={s.icon} />
      <div className={s.text}>
        <p className="type-body-strong">{VERIFY_CALLOUT.title}</p>
        <p className={s.body}>{VERIFY_CALLOUT.body}</p>
      </div>
    </div>
  );
}
