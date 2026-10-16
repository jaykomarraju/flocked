// The sign-in panel (Paper `core/sign-in/{browser,email-code,mini-app}/*`; spec "Identity and
// personhood" › Identities): what the sign-in sheet (mobile) and modal (tablet up) hold, one `step`
// at a time. Presentational: SignInDialog owns the flow and the calls, and the design sheets draw any
// step with example values.
//   choose          Farcaster, a wallet or an email code, and the note that email can't make an account
//   mini-app        inside a Farcaster client: "Continue as @<username>", a wallet as the fallback
//   email           the address the code goes to (no artboard: built from the kit)
//   code            the emailed code, "Sign in", and a resend
//   farcaster-wait  in a browser, Farcaster's approval link while the relay waits (no artboard)
// Errors are the ErrorBox (the API's message for a 4xx, the error voice line otherwise); a field's own
// problem (an address or a code that can't be right) is the field's error. Input is kept on errors.
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { ErrorBox } from '../ui/ErrorBox';
import { Field } from '../ui/Field';
import { TextButton } from '../ui/TextButton';
import { SpinnerIcon } from '../ui/icons/SpinnerIcon';
import { DialogTitle } from '../ui/useDialog';
import { FarcasterIcon, MailIcon, WalletIcon } from './SignInIcons';
import s from './SignInPanel.module.css';

export type SignInStep = 'choose' | 'mini-app' | 'email' | 'code' | 'farcaster-wait';

/** The action in flight, whose button shows the spinner. */
export type SignInPending = 'farcaster' | 'wallet' | 'email' | 'code' | 'resend';

/** The API's email codes: 8 digits (`EmailCodeSchema`), alive for 5 minutes (`AUTH_SECRET_TTL_MS`). */
export const EMAIL_CODE_LENGTH = 8;
export const EMAIL_CODE_MINUTES = 5;

/** The Farcaster account the mini app is signed in to. */
export interface SignInAccount {
  username?: string;
  displayName?: string;
  pfpUrl?: string;
}

export interface SignInPanelProps {
  step: SignInStep;
  /** The mini app's Farcaster account (`mini-app`). */
  account?: SignInAccount | null;
  /** The address the code goes to (`email`, and named in `code`). */
  email?: string;
  onEmailChange?: (email: string) => void;
  /** The code as typed (`code`). */
  code?: string;
  onCodeChange?: (code: string) => void;
  /** Farcaster's approval URL (`farcaster-wait`). */
  approvalUrl?: string | null;
  pending?: SignInPending | null;
  /** A failed call: the ErrorBox. */
  error?: string | null;
  /** The current field's own error (a malformed address, a short code). */
  fieldError?: string | null;
  /** A new code went out (`code`): the note says so. */
  resent?: boolean;
  /** The code's digits and lifetime in minutes; the API's unless a sheet draws Paper's example. */
  codeLength?: number;
  codeMinutes?: number;
  /** Draws the code field focused (the design sheets). */
  forceCodeFocus?: boolean;
  onFarcaster?: () => void;
  onWallet?: () => void;
  /** "Email me a code" on `choose`: on to `email`. */
  onChooseEmail?: () => void;
  onSubmitEmail?: () => void;
  onSubmitCode?: () => void;
  onResend?: () => void;
  /** Stops waiting for Farcaster (`farcaster-wait`). */
  onCancelFarcaster?: () => void;
  /** "Not now". */
  onClose?: () => void;
}

const noop = () => undefined;

/** "a 6-digit code", "an 8-digit code". */
function article(n: number): 'a' | 'an' {
  return n === 8 || n === 11 || n === 18 || (n >= 80 && n < 90) ? 'an' : 'a';
}

/** Digits only, at most `length`: what the code field keeps of what was typed or pasted. */
export function codeDigits(value: string, length: number): string {
  return value.replace(/\D/g, '').slice(0, length);
}

export function SignInPanel(props: SignInPanelProps) {
  const { step, error } = props;
  const root = useRef<HTMLDivElement>(null);
  const shown = useRef(step);

  // A new step moves focus to its first control (the dialog itself takes focus when it opens).
  useEffect(() => {
    if (step === shown.current) return;
    shown.current = step;
    const node = root.current;
    const target =
      node?.querySelector<HTMLElement>('[data-autofocus]') ??
      node?.closest<HTMLElement>('[role="dialog"]');
    target?.focus();
  }, [step]);

  const errorBox = error ? <ErrorBox message={error} /> : null;
  return (
    <div ref={root} className={s.panel} data-step={step}>
      {step === 'choose' && <Choose {...props} errorBox={errorBox} />}
      {step === 'mini-app' && <MiniApp {...props} errorBox={errorBox} />}
      {step === 'email' && <EmailStep {...props} errorBox={errorBox} />}
      {step === 'code' && <CodeStep {...props} errorBox={errorBox} />}
      {step === 'farcaster-wait' && <FarcasterWait {...props} errorBox={errorBox} />}
    </div>
  );
}

type StepProps = SignInPanelProps & { errorBox: ReactNode };

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={s.heading}>
      <DialogTitle className={`type-title ${s.title}`}>{title}</DialogTitle>
      <p className="type-body">{children}</p>
    </div>
  );
}

function Note({ children, live }: { children: ReactNode; live?: boolean }) {
  return (
    <p className={`type-label ${s.quiet}`} aria-live={live ? 'polite' : undefined}>
      {children}
    </p>
  );
}

function Provider({
  icon,
  label,
  loading,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="secondary"
      className={s.provider}
      loading={loading}
      loadingLabel={label}
      onClick={onClick}
    >
      <span className={s.providerLabel}>
        {icon}
        {label}
      </span>
    </Button>
  );
}

function Choose({ pending, errorBox, onFarcaster, onWallet, onChooseEmail }: StepProps) {
  const busy = Boolean(pending);
  const guard = (fn: (() => void) | undefined) => () => {
    if (!busy) (fn ?? noop)();
  };
  return (
    <>
      <Heading title="Sign in to Flocked">Pick one. You can link the others later.</Heading>
      {errorBox}
      <div className={s.group}>
        <Provider
          icon={<FarcasterIcon className={s.icon} />}
          label="Continue with Farcaster"
          loading={pending === 'farcaster'}
          onClick={guard(onFarcaster)}
        />
        <Provider
          icon={<WalletIcon className={s.icon} />}
          label="Connect a wallet"
          loading={pending === 'wallet'}
          onClick={guard(onWallet)}
        />
        <Provider
          icon={<MailIcon className={s.icon} />}
          label="Email me a code"
          loading={false}
          onClick={guard(onChooseEmail)}
        />
      </div>
      <Note>
        Email works once it&apos;s linked to an account. New here? Start with Farcaster or a wallet.
      </Note>
    </>
  );
}

function MiniApp({ account, pending, errorBox, onFarcaster, onWallet }: StepProps) {
  const handle = account?.username ? `@${account.username}` : null;
  const name = handle ?? account?.displayName ?? 'Your Farcaster account';
  const busy = Boolean(pending);
  return (
    <>
      <Heading title="You're in Farcaster">Farcaster can sign you in. Nothing to type.</Heading>
      {errorBox}
      <div className={s.group}>
        <div className={s.account}>
          <Avatar
            handle={account?.username ?? account?.displayName ?? '?'}
            size={40}
            src={account?.pfpUrl}
          />
          <div className={s.accountText}>
            <p className="type-body-strong">{name}</p>
            <p className={`type-label ${s.quiet}`}>Farcaster account</p>
          </div>
        </div>
        <Button
          className={s.block}
          loading={pending === 'farcaster'}
          loadingLabel="Signing in"
          onClick={() => !busy && (onFarcaster ?? noop)()}
        >
          {handle ? `Continue as ${handle}` : 'Continue with Farcaster'}
        </Button>
        <Button
          variant="secondary"
          className={s.block}
          loading={pending === 'wallet'}
          loadingLabel="Check your wallet"
          onClick={() => !busy && (onWallet ?? noop)()}
        >
          Use a wallet instead
        </Button>
      </div>
      <Note>Linking a wallet or email later keeps your points in one place.</Note>
    </>
  );
}

function submit(fn: (() => void) | undefined) {
  return (e: FormEvent) => {
    e.preventDefault();
    (fn ?? noop)();
  };
}

function EmailStep({
  email = '',
  onEmailChange,
  pending,
  errorBox,
  fieldError,
  onSubmitEmail,
  onClose,
}: StepProps) {
  return (
    <>
      <Heading title="Sign in with email">
        We&apos;ll send a code to the email on your account.
      </Heading>
      {errorBox}
      <form className={s.group} noValidate onSubmit={submit(pending ? noop : onSubmitEmail)}>
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          error={fieldError}
          onChange={(e) => (onEmailChange ?? noop)(e.target.value)}
          data-autofocus=""
        />
        <Button
          type="submit"
          className={s.block}
          loading={pending === 'email'}
          loadingLabel="Sending"
        >
          Email me a code
        </Button>
      </form>
      <TextButton className={s.notNow} onClick={onClose}>
        Not now
      </TextButton>
    </>
  );
}

function CodeStep({
  email = '',
  code = '',
  onCodeChange,
  pending,
  errorBox,
  fieldError,
  resent = false,
  codeLength = EMAIL_CODE_LENGTH,
  codeMinutes = EMAIL_CODE_MINUTES,
  forceCodeFocus = false,
  onSubmitCode,
  onResend,
}: StepProps) {
  return (
    <>
      <Heading title="Check your email">
        We sent {article(codeLength)} {codeLength}-digit code to {email}. It works for {codeMinutes}{' '}
        minutes.
      </Heading>
      {errorBox}
      <form className={s.group} noValidate onSubmit={submit(pending ? noop : onSubmitCode)}>
        <Field
          className={s.code}
          label="Code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          spellCheck={false}
          required
          value={code}
          error={fieldError}
          forceState={forceCodeFocus ? 'focus' : undefined}
          onChange={(e) => (onCodeChange ?? noop)(codeDigits(e.target.value, codeLength))}
          data-autofocus=""
        />
        <Button
          type="submit"
          className={s.block}
          loading={pending === 'code'}
          loadingLabel="Signing in"
        >
          Sign in
        </Button>
      </form>
      <Note live>
        {resent ? 'A new code is on its way. ' : 'Nothing yet? '}
        <button
          type="button"
          className={s.inlineAction}
          aria-busy={pending === 'resend' || undefined}
          onClick={() => !pending && (onResend ?? noop)()}
        >
          Send a new code.
        </button>
      </Note>
    </>
  );
}

function FarcasterWait({ approvalUrl, errorBox, onCancelFarcaster }: StepProps) {
  return (
    <>
      <Heading title="Approve in Farcaster">
        Open Farcaster and approve the sign-in. This page waits for you.
      </Heading>
      {errorBox}
      <div className={s.group}>
        {approvalUrl ? (
          <a
            className={`type-cta ${s.cta}`}
            href={approvalUrl}
            target="_blank"
            rel="noreferrer"
            data-autofocus=""
          >
            Open Farcaster
          </a>
        ) : null}
        <p className={`type-label ${s.waiting}`} role="status">
          <SpinnerIcon className={s.spinner} />
          Waiting for your approval
        </p>
      </div>
      <TextButton className={s.notNow} onClick={onCancelFarcaster}>
        Cancel
      </TextButton>
    </>
  );
}
