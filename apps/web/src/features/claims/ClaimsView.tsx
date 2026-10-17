// Claims (Paper Core flow `core/claims/{list,claim-all,pending,empty}/*`; spec "Client app" ›
// Claims): the unclaimed Stakes payouts and refunds, what is ready now, what opens later, and
// "Claim all" — every ready payout in one sponsored batch, so the daily sponsorship cap counts it
// once. Presentational, like TodayView and SealedView: the live screen and the design sheets feed it
// plain props, including the already-formatted status words and notes (so an artboard never depends
// on the clock).
import type { ReactNode } from 'react';
import type { Breakpoint } from '../../theme';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorBox } from '../../ui/ErrorBox';
import { formatUsdc } from '../../ui/amounts';
import {
  BACK_TO_TODAY,
  CLAIMING,
  CLAIM_ALL,
  CLAIMS_SUBTITLE,
  CLAIMS_TITLE,
  CONNECT_LINE,
  CONNECT_WALLET,
  EMPTY_LINE,
  READY_LABEL,
  destinationLine,
} from './copy';
import s from './ClaimsView.module.css';

/** One payout in the list, with everything already said the way the row shows it. */
export interface ClaimRow {
  id: string;
  /** "Wed, Oct 7", or "Room round" for a room payout listed by `?wallet=` (no round data). */
  date: string;
  /** "Won", "Refunded", "Rebate". */
  result: string;
  /** The round's question; null for a room payout, which carries none. */
  question: string | null;
  /** USDC base units. */
  amount: bigint;
  /** "Ready", "Opens 11:03pm" or "Claiming". */
  status: string;
  /** The escrow will take it now (it counts towards the ready total). */
  ready: boolean;
}

export interface ClaimsViewProps {
  breakpoint: Breakpoint;
  rows: ClaimRow[];
  /** The ready payouts' total, USDC base units. */
  readyTotal: bigint;
  /** The card's sub-line: what isn't ready yet, or the pending line. Null when there is nothing to add. */
  note: string | null;
  /** The destination wallet, truncated ("0x3f2c…a91c"); null when it isn't known yet. */
  wallet: string | null;
  /** The batch is out: the CTA shows the spinner and the claiming rows say so. */
  claiming?: boolean;
  /** Nothing can be claimed right now (no ready payout, or no wallet to send from). */
  claimDisabled?: boolean;
  /** A batch that didn't go through. */
  error?: string | null;
  onClaimAll?: () => void;
  onBackToToday?: () => void;
  /** Signed out with no wallet yet: the page offers to connect one and lists its claims. */
  connect?: { onConnect: () => void; connecting?: boolean } | null;
  /** The confirm sheet or modal, drawn by the live screen over the page. */
  children?: ReactNode;
}

export function ClaimsView({
  breakpoint,
  rows,
  readyTotal,
  note,
  wallet,
  claiming = false,
  claimDisabled = false,
  error = null,
  onClaimAll,
  onBackToToday,
  connect = null,
  children,
}: ClaimsViewProps) {
  return (
    <>
      <header className={s.heading}>
        <h1 className={s.title} data-breakpoint={breakpoint}>
          {CLAIMS_TITLE}
        </h1>
        <p className="type-body">{CLAIMS_SUBTITLE}</p>
      </header>
      {connect ? (
        <EmptyState
          className={s.empty}
          line={CONNECT_LINE}
          action={
            <Button
              variant="secondary"
              size="small"
              loading={connect.connecting}
              onClick={connect.onConnect}
            >
              {CONNECT_WALLET}
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          className={s.empty}
          line={EMPTY_LINE}
          action={
            <Button variant="secondary" size="small" onClick={onBackToToday}>
              {BACK_TO_TODAY}
            </Button>
          }
        />
      ) : (
        <>
          <section className={s.card}>
            <p className="type-label">{READY_LABEL}</p>
            <p className="type-number-xl">{formatUsdc(readyTotal)} USDC</p>
            {note === null ? null : <p className={`type-label ${s.note}`}>{note}</p>}
            {error === null ? null : <ErrorBox className={s.error} message={error} />}
            <Button
              className={s.cta}
              loading={claiming}
              loadingLabel={CLAIMING}
              disabled={claimDisabled}
              onClick={onClaimAll}
            >
              {CLAIM_ALL}
            </Button>
          </section>
          <ul className={s.rows}>
            {rows.map((row) => (
              <li key={row.id} className={s.row}>
                <div className={s.main}>
                  <p className={`type-caption ${s.meta}`}>
                    {row.date} · {row.result}
                  </p>
                  {row.question === null ? null : (
                    <p className="type-body-strong">{row.question}</p>
                  )}
                </div>
                <div className={s.figure}>
                  <p className="type-number">{formatUsdc(row.amount)} USDC</p>
                  <p className={`type-caption ${s.status}`} data-waiting={!row.ready || undefined}>
                    {row.status}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className={`type-label ${s.footer}`}>{destinationLine(wallet)}</p>
        </>
      )}
      {children}
    </>
  );
}
