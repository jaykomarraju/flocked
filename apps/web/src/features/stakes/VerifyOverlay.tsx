// The verification sheet in its overlay: a bottom sheet on mobile, a modal from tablet up, at the
// sign-in dialog's sizes (Paper draws the two the same way). The design sheets draw it `inline`,
// over the artboard rather than over the page.
import { SignInOverlay } from '../../auth/SignInDialog';
import type { Breakpoint } from '../../theme';
import { VerifySheet, type VerifySheetProps } from './VerifySheet';

export type VerifyOverlayProps = VerifySheetProps & {
  breakpoint: Breakpoint;
  /** Drawn in place (the design sheets) rather than over the page. */
  inline?: boolean;
};

export function VerifyOverlay({ breakpoint, inline, ...sheet }: VerifyOverlayProps) {
  return (
    <SignInOverlay breakpoint={breakpoint} open onClose={sheet.onClose} inline={inline}>
      <VerifySheet {...sheet} />
    </SignInOverlay>
  );
}
