// Pinned for the shell (layout/AppShell renders it); the sign-in builder replaces this stub.
export interface SignInDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SignInDialog({ open }: SignInDialogProps) {
  return open ? null : null;
}
