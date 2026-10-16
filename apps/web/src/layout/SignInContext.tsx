// Whether the sign-in dialog is open. The shell owns the dialog (AppShell renders SignInDialog);
// anything under it opens it: the headers' "Sign in", Today's "Sign in to play", the onboarding's
// last card.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface SignInControl {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}

const SignInContext = createContext<SignInControl | null>(null);

export function SignInProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);
  return <SignInContext.Provider value={value}>{children}</SignInContext.Provider>;
}

export function useSignIn(): SignInControl {
  const control = useContext(SignInContext);
  if (!control) throw new Error('useSignIn outside SignInProvider');
  return control;
}
