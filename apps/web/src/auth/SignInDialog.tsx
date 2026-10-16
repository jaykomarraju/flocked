// The sign-in dialog (spec "Identity and personhood" › Identities; Paper `core/sign-in/*`): a bottom
// sheet on mobile and a modal from tablet up, holding the SignInPanel. It runs the flow over the
// session's sign-ins (session.tsx): in the mini app, Farcaster Quick Auth with a wallet fallback; in a
// browser, Farcaster through the relay (the approval link, then a wait), a wallet (SIWE) or an email
// code. It closes once a sign-in lands; the session has refreshed `GET /me` by then.
import { EmailSchema, VOICE } from '@flocked/shared';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useBreakpoint, type Breakpoint } from '../theme';
import { BottomSheet } from '../ui/BottomSheet';
import { Modal } from '../ui/Modal';
import { useAuth } from './session';
import { EMAIL_CODE_LENGTH, SignInPanel, type SignInPending, type SignInStep } from './SignInPanel';
import s from './SignInDialog.module.css';

// Pinned for the shell (layout/AppShell renders it).
export interface SignInDialogProps {
  open: boolean;
  onClose: () => void;
}

/** True when the user stopped it themselves: a wallet's "reject" (EIP-1193 4001). */
export function isUserCancel(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 6 && e !== null && typeof e === 'object'; depth++) {
    const { name, code, cause } = e as { name?: unknown; code?: unknown; cause?: unknown };
    if (name === 'UserRejectedRequestError' || code === 4001) return true;
    e = cause;
  }
  return false;
}

/** What the error box says: the API's message for a 4xx, the error voice line for anything else. */
export function signInErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.isClientError) return err.message;
  return VOICE.error;
}

export function SignInDialog({ open, onClose }: SignInDialogProps) {
  const breakpoint = useBreakpoint();
  const { close, ...flow } = useSignInFlow(open, onClose);
  return (
    <SignInOverlay breakpoint={breakpoint} open={open} onClose={close}>
      <SignInPanel {...flow} onClose={close} />
    </SignInOverlay>
  );
}

export interface SignInOverlayProps {
  breakpoint: Breakpoint;
  open: boolean;
  onClose: () => void;
  /** Drawn in place (the design sheets) rather than over the page. */
  inline?: boolean;
  children: ReactNode;
}

/** The sheet (mobile) or the modal (tablet up) at Paper's sign-in sizes. */
export function SignInOverlay({ breakpoint, open, onClose, inline, children }: SignInOverlayProps) {
  return breakpoint === 'mobile' ? (
    <BottomSheet open={open} onClose={onClose} inline={inline} className={s.sheet}>
      {children}
    </BottomSheet>
  ) : (
    <Modal
      open={open}
      onClose={onClose}
      closeOnScrim
      inline={inline}
      scrimClassName={inline ? s.inlineScrim : undefined}
      className={s.modal}
    >
      {children}
    </Modal>
  );
}

const NOT_AN_EMAIL = "That doesn't look like an email address.";
const SHORT_CODE = `The code is ${EMAIL_CODE_LENGTH} digits.`;

function useSignInFlow(open: boolean, onClose: () => void) {
  const auth = useAuth();
  const { miniApp } = auth;
  const firstStep: SignInStep = miniApp ? 'mini-app' : 'choose';
  const [step, setStep] = useState<SignInStep>(firstStep);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<SignInPending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  // Each opening is one attempt: answers that arrive after a close or a cancel are dropped.
  const attempt = useRef(0);
  const cancelRelay = useRef<(() => void) | null>(null);

  // A fresh dialog each time it opens (set during render, so the last step never flashes).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep(firstStep);
      setEmail('');
      setCode('');
      setPending(null);
      setError(null);
      setFieldError(null);
      setResent(false);
      setApprovalUrl(null);
    }
  }

  /** Drops whatever is in flight: its answer is ignored and the Farcaster relay stops polling. */
  const abandon = useCallback(() => {
    attempt.current += 1;
    cancelRelay.current?.();
    cancelRelay.current = null;
  }, []);

  useEffect(() => {
    if (!open) abandon();
  }, [open, abandon]);
  useEffect(() => abandon, [abandon]);

  const close = useCallback(() => {
    abandon();
    onClose();
  }, [abandon, onClose]);

  /**
   * One call: the spinner on `what`, then `done` (by default: close, signed in), or the error box
   * (nothing when the user cancelled in their wallet) and `failed`.
   */
  async function run(
    what: SignInPending,
    call: () => Promise<void>,
    then: { done?: () => void; failed?: () => void } = {},
  ) {
    const id = attempt.current;
    setPending(what);
    setError(null);
    setFieldError(null);
    try {
      await call();
      if (id !== attempt.current) return;
      // A relay that answered has nothing left to stop.
      cancelRelay.current = null;
      setPending(null);
      if (then.done) then.done();
      else onClose();
    } catch (err) {
      if (id !== attempt.current) return;
      setPending(null);
      if (!isUserCancel(err)) setError(signInErrorMessage(err));
      then.failed?.();
    }
  }

  return {
    step,
    account: miniApp?.user ?? null,
    email,
    code,
    pending,
    error,
    fieldError,
    resent,
    approvalUrl,
    close,
    onEmailChange: setEmail,
    onCodeChange: setCode,
    onWallet: () => void run('wallet', auth.signInWithWallet),
    onFarcaster: () =>
      void run(
        'farcaster',
        () =>
          auth.signInWithFarcaster({
            onApprove: (url, cancel) => {
              cancelRelay.current = cancel;
              setApprovalUrl(url);
              setPending(null);
              setStep('farcaster-wait');
            },
          }),
        {
          // A relay that timed out or failed goes back to the providers, with the error.
          failed: () => {
            cancelRelay.current = null;
            setApprovalUrl(null);
            setStep(firstStep);
          },
        },
      ),
    onCancelFarcaster: () => {
      abandon();
      setApprovalUrl(null);
      setPending(null);
      setError(null);
      setStep(firstStep);
    },
    onChooseEmail: () => {
      setError(null);
      setStep('email');
    },
    onSubmitEmail: () => {
      const address = email.trim();
      if (!EmailSchema.safeParse(address).success) {
        setError(null);
        setFieldError(NOT_AN_EMAIL);
        return;
      }
      void run('email', () => auth.startEmail(address), {
        done: () => {
          setEmail(address);
          setCode('');
          setResent(false);
          setStep('code');
        },
      });
    },
    onSubmitCode: () => {
      if (code.length !== EMAIL_CODE_LENGTH) {
        setError(null);
        setFieldError(SHORT_CODE);
        return;
      }
      void run('code', () => auth.verifyEmail(email, code));
    },
    onResend: () =>
      void run('resend', () => auth.startEmail(email), {
        done: () => {
          setCode('');
          setResent(true);
        },
      }),
  };
}
