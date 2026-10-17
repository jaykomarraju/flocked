// The Stakes verification sheet (Paper `core/stakes-entry/verify-sheet/*`; spec "Client app" › Entry
// flow (Stakes) step 1, "Compliance and responsible play" › Age and terms): a bottom sheet on mobile
// and a modal from tablet up, carrying the age attestation and the terms acceptance as two
// checkboxes. "Verify with Coinbase" is disabled until both are ticked (W3-C.2 decision).
//
// Ticking them is `POST /me/tos` (the age the checkbox named, and the current ToS version); the
// button then starts `POST /me/personhood` and opens Coinbase. Inside the mini app that opens an
// external browser and the app polls `/me` until verification lands, because the OAuth flow cannot
// finish in the mini app's webview (spec "Client app" › Entry flow (Stakes) step 1).
import type { AgeAttestation } from '@flocked/shared';
import { useState, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { DialogTitle } from '../../ui/useDialog';
import { Checkbox } from '../../ui/Checkbox';
import { ErrorBox } from '../../ui/ErrorBox';
import { ageCheckboxLabel, VERIFY_CTA, VERIFY_SHEET, VERIFY_WAITING } from './copy';
import s from './VerifySheet.module.css';

/** Where the responsible-play resources live (the same link Settings carries, W5-C). */
export const RESPONSIBLE_PLAY_HREF = '/responsible-play';
export const STAKES_TERMS_HREF = '/terms#stakes';

export interface VerifySheetProps {
  /** The age the checkbox names: 18, or 21 where the player's country requires it. */
  ageRequired: AgeAttestation;
  /** Both boxes ticked and the button pressed: accept the terms, then open Coinbase. */
  onVerify: (age: AgeAttestation) => void;
  onClose: () => void;
  /** The flow is out at Coinbase (the mini app's external browser): the button waits. */
  waiting?: boolean;
  error?: string | null;
  /** The design sheets draw both boxes ticked. */
  defaultChecked?: boolean;
}

/** The sheet's contents; the screen wraps it in the overlay. */
export function VerifySheet({
  ageRequired,
  onVerify,
  onClose,
  waiting = false,
  error = null,
  defaultChecked = false,
}: VerifySheetProps) {
  const [age, setAge] = useState(defaultChecked);
  const [terms, setTerms] = useState(defaultChecked);
  const ready = age && terms;
  return (
    <div className={s.sheet}>
      <DialogTitle className="type-section">{VERIFY_SHEET.title}</DialogTitle>
      <p className="type-body">{VERIFY_SHEET.body}</p>
      <div className={s.checks}>
        <Checkbox checked={age} onChange={(e) => setAge(e.currentTarget.checked)}>
          {ageCheckboxLabel(ageRequired)}
        </Checkbox>
        <Checkbox checked={terms} onChange={(e) => setTerms(e.currentTarget.checked)}>
          {VERIFY_SHEET.terms}{' '}
          <a className={s.link} href={STAKES_TERMS_HREF} target="_blank" rel="noreferrer">
            {VERIFY_SHEET.termsLink}
          </a>
        </Checkbox>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      <Button
        className={s.cta}
        disabled={!ready}
        loading={waiting}
        loadingLabel={VERIFY_WAITING}
        onClick={() => onVerify(ageRequired)}
      >
        {VERIFY_CTA}
      </Button>
      <Button variant="secondary" className={s.notNow} onClick={onClose}>
        {VERIFY_SHEET.notNow}
      </Button>
      <p className={s.footer}>
        <span>{VERIFY_SHEET.footerAge}</span>
        <span aria-hidden="true"> · </span>
        <a className={s.link} href={RESPONSIBLE_PLAY_HREF}>
          {VERIFY_SHEET.footerLink}
        </a>
      </p>
    </div>
  );
}

/** The sheet in its overlay, as a screen shows it. */
export function VerifyDialog({
  overlay,
  ...props
}: VerifySheetProps & { overlay: (children: ReactNode) => ReactNode }) {
  return overlay(<VerifySheet {...props} />);
}
