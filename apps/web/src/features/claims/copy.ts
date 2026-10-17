// Claims copy and the small formatters the screen needs (Paper `core/claims/*`; spec "Client app" ›
// Claims, "API" › `GET /claims`). Lines not already in Design_Language.md "Voice" are drafts in the
// same voice, the way features/today/copy.ts holds Today's.
//
// `GET /claims` lists the live proposal's payouts during the challenge window with their
// `claimsOpenAt`, and the escrow refuses a claim until the result is final (W7-Z decision D3), so a
// payout inside the window is always shown as claimable-at, never as claimable now.
import { VOICE, type PayoutKind } from '@flocked/shared';
import { formatUsdc } from '../../ui/amounts';
import type { WalletErrorKind } from '../../wallet/send';

/** The page title and the line under it (Paper `core/claims/list/*`). */
export const CLAIMS_TITLE = 'Claims';
export const CLAIMS_SUBTITLE = "Stakes payouts and refunds you haven't claimed yet.";

/** The card above the list. */
export const READY_LABEL = 'Ready to claim';
export const CLAIM_ALL = 'Claim all';
/** The CTA's label while the batch is in flight, and what a claiming row reads. */
export const CLAIMING = 'Claiming';
/** The card's sub-line while the batch is in flight. */
export const PENDING_NOTE = 'Waiting for Base to confirm. Usually a few seconds.';

/** A row that the escrow will take now. */
export const READY = 'Ready';

/** Nothing to claim (Paper `core/claims/empty/*`). */
export const EMPTY_LINE = 'Nothing to claim. The flock owes you nothing.';
export const BACK_TO_TODAY = 'Back to Today';

/** The confirm sheet (mobile) / modal (tablet up). */
export const NOT_NOW = 'Not now';

/** A wallet-only visitor with no session: claim straight from the wallet that played. */
export const CONNECT_LINE = 'Connect the wallet you played with and claim straight from it.';
export const CONNECT_WALLET = 'Connect a wallet';

/** A room-round payout listed by `?wallet=`: no round data, so no date and no question. */
export const ROOM_ROUND = 'Room round';

/** "0x3f2c…a91c": the destination wallet, short enough to read in a line. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The note under the list: where the money lands and that claiming never expires. */
export function destinationLine(wallet: string | null): string {
  const where = wallet === null ? 'the wallet that entered' : `the wallet that entered, ${wallet}`;
  return `Payouts go to ${where}. Claims from rounds you already entered stay open, wherever you are.`;
}

/**
 * Ready payouts that belong to another wallet. `FlockedEscrow.claim` builds its leaf from
 * `msg.sender`, so one batch can only claim what the connected wallet owns; the rest are claimed by
 * signing in with their own wallet, and saying so beats a batch that reverts.
 */
export function otherWalletNote(count: number): string {
  const n = count === 1 ? 'One other payout is' : `${count} other payouts are`;
  return `${n} ready for a different wallet. Connect that wallet to claim ${count === 1 ? 'it' : 'them'}.`;
}

/** What a payout is, in the row's meta line. */
export function resultWord(kind: PayoutKind): string {
  switch (kind) {
    case 'win':
      return 'Won';
    case 'rebate':
      return 'Rebate';
    default:
      return 'Refunded';
  }
}

const DAY = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const SHORT_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function gameDayUtc(gameDay: string): Date {
  const [y = 0, m = 1, d = 1] = gameDay.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** A game day ("2026-10-07") as a row's meta line shows it: "Wed, Oct 7". */
export function formatClaimDay(gameDay: string): string {
  return DAY.format(gameDayUtc(gameDay));
}

/** The same day named in a sentence: "Oct 8". */
export function formatShortDay(gameDay: string): string {
  return SHORT_DAY.format(gameDayUtc(gameDay));
}

const CLOCK = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** A claim-open time as the screen says it: "11:03pm" (the viewer's own clock). */
export function formatClockTime(epochMs: number): string {
  return CLOCK.format(new Date(epochMs))
    .replace(/\s+/g, '')
    .replace(/AM$/, 'am')
    .replace(/PM$/, 'pm');
}

/**
 * A row's status word: "Claiming" while its batch is out, "Ready" once the escrow will take it, and
 * "Opens 11:03pm" while it is still inside its challenge window.
 */
export function claimStatus(opensAt: number | null, ready: boolean, claiming: boolean): string {
  if (claiming) return CLAIMING;
  return ready || opensAt === null ? READY : `Opens ${formatClockTime(opensAt)}`;
}

const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];

const COUNTS = [
  'No',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
];

/** "Two payouts" / "11 payouts": a small count reads as a word, as Paper writes it. */
export function countWord(n: number): string {
  return COUNTS[n] ?? String(n);
}

export interface ReadyNote {
  ready: number;
  total: number;
  /** The waiting payouts' positions in the list (0-based), earliest claim-open time first. */
  waiting: { index: number; opensAt: number }[];
}

/**
 * The card's sub-line: "2 of 3 are ready. The third opens at 11:03pm." Nothing to say when every
 * payout is ready, and with more than one waiting the line names the next one instead of its place.
 */
export function readyNote({ ready, total, waiting }: ReadyNote): string | null {
  const next = waiting[0];
  if (!next || total === 0) return null;
  const count = `${ready} of ${total} ${ready === 1 ? 'is' : 'are'} ready.`;
  const at = formatClockTime(next.opensAt);
  if (waiting.length === 1) {
    const place = ORDINALS[next.index];
    return `${count} ${place ? `The ${place}` : 'The last one'} opens at ${at}.`;
  }
  return `${count} The next opens at ${at}.`;
}

/** The confirm's title and its CTA: "Claim 17.67 USDC". */
export function claimTotal(total: bigint): string {
  return `Claim ${formatUsdc(total)} USDC`;
}

/** "Two payouts, one transaction. They go to 0x3f2c…a91c." */
export function confirmLine(count: number, wallet: string | null): string {
  const what =
    count === 1 ? 'One payout, one transaction.' : `${countWord(count)} payouts, one transaction.`;
  const goes = count === 1 ? 'It goes' : 'They go';
  return wallet === null ? what : `${what} ${goes} to ${wallet}.`;
}

export interface WaitingNote {
  count: number;
  /** The next payout's claim-open time (epoch ms), and its game day when it has one. */
  opensAt: number;
  gameDay: string | null;
}

/** The confirm's line about what this batch leaves behind: "The Oct 8 payout opens at 11:03pm." */
export function waitingNote(waiting: WaitingNote | null): string | null {
  if (waiting === null || waiting.count === 0) return null;
  const at = formatClockTime(waiting.opensAt);
  if (waiting.count > 1) {
    return `${countWord(waiting.count)} more payouts open later. The next is at ${at}.`;
  }
  const which =
    waiting.gameDay === null ? 'One more payout' : `The ${formatShortDay(waiting.gameDay)} payout`;
  return `${which} opens at ${at}. Claim it then.`;
}

/** What the error box says when a batch doesn't go through. A wallet the player waved off is not
 * a fault to apologise for, and the paymaster refusing is not paid around. */
export function walletErrorMessage(kind: WalletErrorKind): string {
  switch (kind) {
    case 'rejected':
      return 'You turned the claim down in your wallet. Nothing was sent.';
    case 'not_sponsored':
      return "We couldn't cover the gas for this claim. Try again in a few minutes.";
    case 'reverted':
      return 'Base turned the claim back. Nothing moved; the payouts are still there.';
    case 'timeout':
      return "Base hasn't confirmed yet. Your claim may still land, so check again in a minute.";
    case 'unsupported':
      return "This wallet can't send a batched claim. Connect another one and try again.";
    default:
      return VOICE.error;
  }
}

/** The same, for the connect that comes before any claim: nothing was being sent yet. */
export function connectErrorMessage(kind: WalletErrorKind): string {
  return kind === 'rejected'
    ? 'Your wallet never connected. Nothing was claimed.'
    : walletErrorMessage(kind);
}
