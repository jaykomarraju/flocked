// Stakes copy (spec "Client app" › Today and Entry flow (Stakes); "Compliance and responsible
// play"). Lines not in Design_Language.md "Voice" or on a Paper artboard are drafts in the same
// voice, listed as spec issues in docs/sessions/W10-C.md for the owner to approve.
import { VOICE } from '@flocked/shared';
import type { IneligibleReason } from '@flocked/shared';
import type { ConfigMismatch, NonDefault } from './configCheck';
import type { WalletErrorKind } from '../../wallet/send';

// Eligibility --------------------------------------------------------------------------------

/** The verify callout on Today, above the countdown (Paper `core/today/open-stakes-unverified/*`). */
export const VERIFY_CALLOUT = {
  title: 'Stakes needs a verified account',
  body: 'Verify once with Coinbase to play for USDC. It takes about a minute. 18+ only.',
} as const;
export const VERIFY_CTA = 'Verify with Coinbase';

/** The verification sheet (Paper `core/stakes-entry/verify-sheet/*`). */
export const VERIFY_SHEET = {
  title: 'Stakes needs a verified account',
  body: 'Verify with Coinbase to play for USDC. It opens in your browser and takes about a minute.',
  terms: 'I accept the',
  termsLink: 'Stakes terms',
  notNow: 'Not now',
  footerAge: '18+ only',
  footerLink: 'Responsible play',
} as const;

/** "I'm 18 or older", or 21 where the player's country requires it (`TosState.ageRequired`). */
export function ageCheckboxLabel(age: 18 | 21): string {
  return `I'm ${age} or older`;
}

/**
 * Why Stakes is not on offer. `not_verified` is the one reason that still *shows* Stakes, with
 * "Verify with Coinbase" (spec "Client app" › Today); every other reason hides the mode altogether,
 * so these lines are what the player is told if they reach Stakes another way.
 */
export const INELIGIBLE_LINES: Record<IneligibleReason, string> = {
  not_verified: 'Verify with Coinbase to play Stakes.',
  country_unverified: "We couldn't check where your account is verified, so Stakes is off.",
  country_mismatch: "Your verified country doesn't match your account's, so Stakes is off.",
  geo_blocked: 'Stakes isn’t available where you are. Free still is.',
  proxy_detected: "We can't tell where you are, so Stakes is off. Free still works.",
  age_unattested: 'Confirm your age to play Stakes.',
  tos_not_accepted: 'Accept the Stakes terms to play.',
  self_excluded: "You're on a break. Claims and refunds still work.",
  suspended: 'This account is suspended. Stakes is off.',
  stakes_disabled: 'Stakes is off right now. Free is still on.',
};

/**
 * Today while the player is on a self-exclusion break (Paper `core/global/self-excluded/*`; spec
 * "Compliance and responsible play" › Responsible play): the question stays, both options are
 * disabled and there is no stake selector and no CTA, because a break blocks entries in both modes.
 * Claims and refunds are unaffected, which the link says.
 */
export function breakNotice(until: string): {
  title: string;
  body: string;
  link: { label: string; href: string };
} {
  return {
    title: `You're on a break until ${until}.`,
    body: 'No picks in either mode until then, and no game notifications.',
    link: { label: 'Claims and refunds still work', href: '/claims' },
  };
}

/** The mini app sends verification to an external browser and waits for `/me` to catch up. */
export const VERIFY_WAITING = 'Finish in your browser. This page is waiting.';

// The round config ---------------------------------------------------------------------------

/** The non-default notice above the question (Paper `core/today/config-warning/*`). */
export const CONFIG_NOTICE_TITLE = 'Special rules today';

const NON_DEFAULT_PHRASE: Record<NonDefault['field'], (v: string, usual: string) => string> = {
  // Paper names the unit once: "Stake 10 USDC (usually 5)".
  stake: (v, usual) => `Stake ${plain(v)} (usually ${bare(usual)})`,
  minEntrants: (v, usual) => `At least ${v} players (usually ${usual})`,
  feeBps: (v, usual) => `${bps(v)} house fee (usually ${bps(usual)})`,
  creatorBps: (v, usual) => `${bps(v)} to the author (usually ${bps(usual)})`,
  capMultiple: (v, usual) => `Payouts capped at ${v}x (usually ${usual}x)`,
};

/** "10.00 USDC" reads as "10 USDC" in a sentence. */
const plain = (usdc: string) => usdc.replace(/\.00 /, ' ');
/** The same amount without its unit, for the "(usually 5)" the unit before it already covers. */
const bare = (usdc: string) => plain(usdc).replace(/ USDC$/, '');
const bps = (v: string) => `${Number(v) / 100}%`;

/** "Stake 10 USDC (usually 5). At least 30 players (usually 20)." */
export function configNoticeBody(values: readonly NonDefault[]): string {
  return values.map((v) => `${NON_DEFAULT_PHRASE[v.field](v.value, v.usual)}.`).join(' ');
}

/** "See the change log (#A1F3, #A1F4)", or null when the API published no audit rows. */
export function changeLogLine(values: readonly NonDefault[]): string | null {
  const ids = [...new Set(values.map((v) => v.auditId).filter((id): id is string => id !== null))];
  return ids.length === 0 ? null : `See the change log (${ids.map((id) => `#${id}`).join(', ')})`;
}

/** The refusal notice (Paper `core/stakes-entry/mismatch/*`): the CTA is disabled under it. */
export const MISMATCH_TITLE = "This round doesn't match its onchain record";
export const MISMATCH_DETAILS = "See what doesn't match";

/** The first difference, in plain words; the rest are behind "See what doesn't match". */
export function mismatchBody(mismatches: readonly ConfigMismatch[]): string {
  const first = mismatches[0];
  if (!first) return "We won't build your entry while they differ.";
  if (first.field === 'round') {
    return "This round isn't on Base the way it was published. We won't build your entry.";
  }
  return `The published ${FIELD_NAMES[first.field] ?? first.field} is ${first.published}. Onchain it's ${first.onchain}. We won't build your entry while they differ.`;
}

const FIELD_NAMES: Record<string, string> = {
  opensAt: 'opening time',
  closesAt: 'closing time',
  beaconRound: 'timelock round',
  'beaconRound (delay)': 'timelock round',
  stake: 'stake',
  feeBps: 'house fee',
  creatorBps: "author's share",
  capMultiple: 'payout cap',
  minEntrants: 'minimum players',
  creator: "author's payout address",
  questionHash: 'question',
};

/** How one mismatch reads in the expanded list. */
export function mismatchRow(m: ConfigMismatch): string {
  return `${FIELD_NAMES[m.field] ?? m.field}: published ${m.published}, onchain ${m.onchain}`;
}

/** The chain could not be read at all: the client refuses rather than trust the API alone. */
export const CONFIG_UNREADABLE =
  "We couldn't reach Base to check this round against its onchain record, so we won't build your entry.";

// The entry ----------------------------------------------------------------------------------

/** The Stakes stake card (Paper `core/today/open-stakes/*`): the round's fixed stake. */
export const STAKE_LABEL = 'Stake';
export const STAKE_FIXED = 'Same for everyone';

/** Under the CTA while the user operation is out (Paper `core/stakes-entry/pending/*`). */
export const PENDING_NOTE = 'Waiting for Base to include your entry. Usually a few seconds.';
export const PENDING_CTA = 'Confirming';

/** What a failed user operation says. A rejected signature is the player's own choice, not a fault. */
export function walletErrorMessage(kind: WalletErrorKind): string {
  switch (kind) {
    case 'rejected':
      return 'You turned the entry down in your wallet. Nothing was staked.';
    case 'not_sponsored':
      return "We couldn't cover the gas for this entry. Try again in a minute.";
    case 'reverted':
      return "Base turned the entry down. Your USDC didn't move.";
    case 'timeout':
      return "Base hasn't included your entry yet. It may still land — check back in a minute.";
    case 'unsupported':
      return 'This wallet can’t batch the entry. Sign in with a Coinbase Smart Wallet to play Stakes.';
    case 'failed':
      return VOICE.error;
  }
}

/** API error codes `POST /entries/stakes/prepare` can answer with. */
export function prepareErrorMessage(code: string): string {
  switch (code) {
    case 'round_closed':
    case 'round_not_open':
      return VOICE.entryClosed;
    case 'already_entered':
      return 'You already sealed a pick in this round.';
    case 'not_eligible':
    case 'not_verified':
      return 'Verify with Coinbase to play Stakes.';
    case 'self_excluded':
      return "You're on a break. No picks until it ends.";
    case 'daily_cap_reached':
      return "That's your daily Stakes limit. Free is still open.";
    case 'rate_limited':
      return 'Too many tries. Wait a minute and try again.';
    case 'network':
      return VOICE.offline;
    default:
      return VOICE.error;
  }
}

/** The wallet the entry (and so the payout) belongs to, as a row shows it: `0x3f2c…a91c`. */
export function shortWallet(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
