// Onboarding (spec "Client app" › Onboarding; Paper `core/onboarding/card-{1,2,3}/*`): a three-card
// explainer in a modal, then sign-in. Each card has its place ("1 of 3") and the close button, a sheep
// (neutral, smug, walking away), a title and a line, the pager and one CTA: "Next", then "Sign in to
// play" on the last card. Paper draws the same centred modal at every breakpoint (full width less 16
// on mobile, 400 from tablet up), so it is the Modal everywhere.
//
// Paging: "Next", or the arrow keys anywhere in the dialog (Left goes back; Paper draws no back
// button). The pager dots only show the place, which the "n of 3" line also says.
//
// `Onboarding` shows it once: automatically to a signed-out visitor whose browser hasn't got the
// `flocked.onboarded` flag. Closing it any way sets the flag; "Sign in to play" also opens sign-in.
import type { MascotPose } from '@flocked/shared';
import { Mascot } from '@flocked/shared/mascot/react';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/session';
import { useSignIn } from '../layout/SignInContext';
import { readLocal, writeLocal } from '../lib/storage';
import { Button } from '../ui/Button';
import { DialogTitle, Modal, ModalCloseButton } from '../ui/Modal';
import s from './OnboardingModal.module.css';

/** The localStorage flag: set once the visitor has closed onboarding. */
export const ONBOARDED_KEY = 'flocked.onboarded';

export interface OnboardingCard {
  pose: MascotPose;
  title: string;
  body: string;
}

/** The three cards, as Paper has them. */
export const ONBOARDING_CARDS: readonly OnboardingCard[] = [
  {
    pose: 'neutral',
    title: 'Pick the side fewer people pick',
    body: 'One question a day, two answers. When the picks unseal, the smaller side wins.',
  },
  {
    pose: 'smug',
    title: 'Picks stay sealed until just after 9pm ET',
    body: 'Each pick is locked with a public timelock that opens for everyone at once, a minute after the round closes. Nobody can peek. Not even us.',
  },
  {
    pose: 'walking-away',
    title: 'The Flock loses. Strays win.',
    body: "If most people picked what you picked, you got flocked. Pick the smaller side and the bigger side's stakes come to you.",
  },
];

export interface OnboardingModalProps {
  open: boolean;
  /** Closed without signing in: the close button, Escape. */
  onClose: () => void;
  /** "Sign in to play" on the last card. */
  onSignIn: () => void;
  /** The card it opens on, 0 to 2 (design sheets). */
  initialCard?: number;
  /** Render in place (design sheets). */
  inline?: boolean;
}

export function OnboardingModal({
  open,
  onClose,
  onSignIn,
  initialCard = 0,
  inline = false,
}: OnboardingModalProps) {
  const last = ONBOARDING_CARDS.length - 1;
  const [index, setIndex] = useState(() => Math.min(Math.max(initialCard, 0), last));
  const card = ONBOARDING_CARDS[index] ?? ONBOARDING_CARDS[0]!;

  // Arrow keys page wherever focus is in the dialog (and it is modal, so focus is in it).
  useEffect(() => {
    if (!open || inline) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, last));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, inline, last]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      inline={inline}
      scrimClassName={inline ? s.inlineScrim : undefined}
    >
      <div className={s.top}>
        <p className="type-number-small">
          {index + 1} of {ONBOARDING_CARDS.length}
        </p>
        <ModalCloseButton />
      </div>
      <div className={s.sheep}>
        <Mascot pose={card.pose} size={120} />
      </div>
      <div className={s.text} aria-live="polite">
        <DialogTitle className={s.title}>{card.title}</DialogTitle>
        <p className="type-body">{card.body}</p>
      </div>
      <div className={s.pager} aria-hidden="true">
        {ONBOARDING_CARDS.map((c, i) => (
          <span key={c.pose} className={s.dot} data-current={i === index || undefined} />
        ))}
      </div>
      <Button className={s.cta} onClick={() => (index < last ? setIndex(index + 1) : onSignIn())}>
        {index < last ? 'Next' : 'Sign in to play'}
      </Button>
    </Modal>
  );
}

/**
 * The app's onboarding: opens by itself for a signed-out visitor on their first visit (no
 * `flocked.onboarded` flag) and never again once closed. A visitor who is signed in has been here
 * before, so that sets the flag too.
 */
export function Onboarding() {
  const { status } = useAuth();
  const signIn = useSignIn();
  const [firstVisit, setFirstVisit] = useState(() => readLocal(ONBOARDED_KEY) === null);

  useEffect(() => {
    if (status !== 'signed-in' || !firstVisit) return;
    writeLocal(ONBOARDED_KEY, '1');
    setFirstVisit(false);
  }, [status, firstVisit]);

  const finish = () => {
    writeLocal(ONBOARDED_KEY, '1');
    setFirstVisit(false);
  };

  return (
    <OnboardingModal
      open={firstVisit && status === 'signed-out'}
      onClose={finish}
      onSignIn={() => {
        finish();
        signIn.open();
      }}
    />
  );
}
