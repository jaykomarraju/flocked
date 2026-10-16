// Core flow › Sign-in (Paper `core/sign-in/{browser,email-code,mini-app}/{mobile,tablet,desktop}`):
// the real SignInPanel in the real sign-in sheet (mobile) or modal (tablet up), drawn in place over
// signed-out Today. The email-code artboards show Paper's example, a 6-digit code that works for 10
// minutes, being typed; the live app says what the API does (8 digits, 5 minutes).
import { SignInOverlay } from '../../auth/SignInDialog';
import { SignInPanel, type SignInPanelProps } from '../../auth/SignInPanel';
import type { SheetDef } from '../types';
import { CoreArtboard } from './frames';

const noop = () => undefined;

const STATES = ['browser', 'email-code', 'mini-app'] as const;
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

const PANELS: Record<(typeof STATES)[number], SignInPanelProps> = {
  browser: { step: 'choose' },
  'email-code': {
    step: 'code',
    email: 'jay@example.com',
    code: '482 91',
    codeLength: 8,
    codeMinutes: 5,
    forceCodeFocus: true,
  },
  'mini-app': { step: 'mini-app', account: { username: 'jay' } },
};

const sheet: SheetDef = {
  name: 'core/sign-in',
  artboards: STATES.flatMap((state) => BREAKPOINTS.map((bp) => `${state}/${bp}`)),
  render: (state, breakpoint) => (
    <CoreArtboard
      breakpoint={breakpoint}
      overlay={
        <SignInOverlay breakpoint={breakpoint} open inline onClose={noop}>
          <SignInPanel {...PANELS[state as (typeof STATES)[number]]} />
        </SignInOverlay>
      }
    />
  ),
};

export default sheet;
