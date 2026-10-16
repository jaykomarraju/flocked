// The header's balance slot (Paper Components › Navigation; docs/design/README.md "Screen
// conventions"): points in Free, the 30-day Stakes net in Stakes ("30 days: +12 USDC"), which links
// to the Stakes history under You. Inter 500 with tabular figures, ink: 16/24 in the desktop header,
// 14/20 in the mobile header.
import { Link } from 'react-router';
import { formatUsdc, groupDigits } from './amounts';
import s from './BalanceSlot.module.css';

export type Balance =
  | { mode: 'free'; points: bigint | number }
  /** `net` is the 30-day net result in USDC base units; `href` is the Stakes history. */
  | { mode: 'stakes'; net: bigint; href?: string };

/** "640 points", or "30 days: +12 USDC" (a loss reads "30 days: -3 USDC"). */
export function balanceText(balance: Balance): string {
  if (balance.mode === 'stakes') {
    const sign = balance.net > 0n ? '+' : '';
    return `30 days: ${sign}${formatUsdc(balance.net)} USDC`;
  }
  const n = balance.points;
  return `${groupDigits(n)} ${n === 1 || n === 1n ? 'point' : 'points'}`;
}

export function BalanceSlot({
  balance,
  size = 'desktop',
}: {
  balance: Balance;
  size?: 'mobile' | 'desktop';
}) {
  const className = `${size === 'mobile' ? 'type-number-small' : 'type-number'} ${s.balance}`;
  const text = balanceText(balance);
  if (balance.mode === 'stakes' && balance.href) {
    return (
      <Link to={balance.href} className={className}>
        {text}
      </Link>
    );
  }
  return <span className={className}>{text}</span>;
}
