// Core flow › Today (Paper `core/today/{open-signed-out,open-free,sealing,dst-notice,open-stakes,
// open-stakes-unverified,config-warning}/{mobile,tablet,desktop}`): the real TodayView in the real
// ShellFrame with Paper's example data. Signed out: "Sign in to play" and the Free note. Signed in
// (avatar "J", 640 points): "100 duck-sized horses" picked and the 25 preset; `sealing` spins the
// CTA, disables the other option and shows the sealing note; `dst-notice` is Saturday, Oct 31, the
// 25-hour round, with the "Clocks go back tonight" notice.
// The Stakes states keep the same round and pick, on the Stakes side of the toggle (212 in):
//   open-stakes             verified: the round's fixed 5 USDC and the 30-day net in the header
//   open-stakes-unverified  the verify callout where the stake box sits, "Verify with Coinbase" as
//                           the CTA, and no balance in the header (none until Stakes is on)
//   config-warning          a round that isn't the usual one: the "Special rules today" notice (2px
//                           ink border, info mark) with the change log, stake 10 USDC, 2,120 in the pot
// The Stakes entry states (`core/stakes-entry/*`) and the two global ones that hide Stakes build on
// these; their sheets take the round from here.
import { VerifyCallout } from '../../features/stakes/VerifyCallout';
import type { NonDefault } from '../../features/stakes/configCheck';
import {
  CONFIG_NOTICE_TITLE,
  VERIFY_CTA,
  changeLogLine,
  configNoticeBody,
} from '../../features/stakes/copy';
import type { TodayViewProps } from '../../features/today/TodayView';
import type { Balance } from '../../ui/BalanceSlot';
import { FREE_STAKE_MAX, FREE_STAKE_MIN, FREE_STAKE_PRESETS } from '../../ui/StakeSelector';
import type { SheetDef } from '../types';
import { CoreArtboard, EXAMPLE_PLAYER, type CoreArtboardProps } from './frames';

const noop = () => undefined;

const STATES = [
  'open-signed-out',
  'open-free',
  'sealing',
  'dst-notice',
  'open-stakes',
  'open-stakes-unverified',
  'config-warning',
] as const;
type State = (typeof STATES)[number];
const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;

/** Signed in, Free, "100 duck-sized horses" picked, the 25 preset. */
export const SIGNED_IN: Partial<TodayViewProps> = {
  signedIn: true,
  pick: '1',
  stake: {
    value: 25,
    onChange: noop,
    min: FREE_STAKE_MIN,
    max: FREE_STAKE_MAX,
    presets: FREE_STAKE_PRESETS,
    balance: 640,
  },
  onSeal: noop,
};

/** The same round on Stakes: the round's fixed 5 USDC, 212 in, 1,060 USDC in the pot. */
export const STAKES: Partial<TodayViewProps> = {
  signedIn: true,
  mode: 'stakes',
  pick: '1',
  stakesStake: { stake: 5_000_000n },
  entrants: 212,
  pool: 1_060_000_000n,
  onSeal: noop,
};

/** The header's 30-day Stakes net ("30 days: +12 USDC"), shown whenever Stakes is selected. */
export const STAKES_PLAYER: CoreArtboardProps['player'] = {
  user: EXAMPLE_PLAYER.user,
  balance: { mode: 'stakes', net: 12_000_000n },
};

/**
 * The unverified player: the avatar, and no balance slot at all (Paper draws none until Stakes is
 * on). `ShellFrame` takes `balance: Balance | null`; the frame's `player` narrows it to a `Balance`.
 */
export const UNVERIFIED_PLAYER: CoreArtboardProps['player'] = {
  user: EXAMPLE_PLAYER.user,
  balance: null as unknown as Balance,
};

/** Stakes as an unverified player sees it: the callout, and the CTA that opens the sheet. */
export const UNVERIFIED: Partial<TodayViewProps> = {
  signedIn: true,
  mode: 'stakes',
  pick: '1',
  entrants: 212,
  pool: 1_060_000_000n,
  callout: <VerifyCallout />,
  ctaLabel: VERIFY_CTA,
  onSeal: noop,
};

/**
 * Paper's non-default round: stake 10 USDC and 30 players, each with a change-log row, exactly as
 * `nonDefaults()` reports them from the locked config.
 */
export const NON_DEFAULTS: readonly NonDefault[] = [
  { field: 'stake', value: '10.00 USDC', usual: '5.00 USDC', auditId: 'A1F3' },
  { field: 'minEntrants', value: '30', usual: '20', auditId: 'A1F4' },
];

/** The same round at the non-default values: 10 USDC a head, so 2,120 USDC from 212 players. */
export const NON_DEFAULT_ROUND: Partial<TodayViewProps> = {
  ...STAKES,
  stakesStake: { stake: 10_000_000n },
  pool: 2_120_000_000n,
};

const TODAY: Record<State, Partial<TodayViewProps> | null> = {
  'open-signed-out': null,
  'open-free': SIGNED_IN,
  sealing: { ...SIGNED_IN, sealing: true },
  'dst-notice': {
    ...SIGNED_IN,
    date: 'Saturday, Oct 31',
    notice: {
      title: 'Clocks go back tonight',
      body: 'So this round runs 25 hours. It still closes at 9pm ET.',
    },
    remainingMs: (24 * 3600 + 58 * 60 + 10) * 1000,
    entrants: 86,
    pool: 2_150n,
  },
  'open-stakes': STAKES,
  'open-stakes-unverified': UNVERIFIED,
  'config-warning': {
    ...NON_DEFAULT_ROUND,
    notice: {
      variant: 'strong',
      title: CONFIG_NOTICE_TITLE,
      body: configNoticeBody(NON_DEFAULTS),
      link: { label: changeLogLine(NON_DEFAULTS) ?? '', onClick: noop },
    },
  },
};

/** The header each state draws: the 30-day net, the points balance, or no balance at all. */
const PLAYER: Partial<Record<State, CoreArtboardProps['player']>> = {
  'open-stakes': STAKES_PLAYER,
  'open-stakes-unverified': UNVERIFIED_PLAYER,
  'config-warning': STAKES_PLAYER,
};

const sheet: SheetDef = {
  name: 'core/today',
  artboards: STATES.flatMap((state) => BREAKPOINTS.map((bp) => `${state}/${bp}`)),
  render: (state, breakpoint) => {
    const today = TODAY[state as State];
    return (
      <CoreArtboard
        breakpoint={breakpoint}
        player={PLAYER[state as State] ?? (today ? EXAMPLE_PLAYER : null)}
        today={today ?? undefined}
      />
    );
  },
};

export default sheet;
