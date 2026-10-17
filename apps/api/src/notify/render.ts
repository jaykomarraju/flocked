// Renders a notify message into each channel's copy, from packages/shared/src/copy/notifications.ts
// only: picks the event's variant, formats the placeholder values (reading what the payload doesn't
// carry: the round's question, the player's side's share from the tally) and fills the templates.
// Push copy is held to PUSH_LIMITS: a longer line is cut, ending in "…" (the spec's rule for the
// `question_rejected` reason, applied to every push line so Farcaster never refuses one).
import {
  NOTIFICATION_COPY,
  OUTCOME_NEXT_LIVE,
  PUSH_LIMITS,
  REFUND_LINES,
  fillCopy,
  formatShare,
  type EmailCopy,
  type Mode,
  type NotificationChannel,
  type NotificationValues,
  type NotifyMessage,
  type PushCopy,
  type RefundReason,
} from '@flocked/shared';
import type { ChannelCopy } from './types.js';

/** The domain in links when APP_ORIGIN is unset (owner decision, Oct 12, 2026). */
export const DEFAULT_ORIGIN = 'https://flocked.xyz';

const ELLIPSIS = '…';
const USDC_UNIT = 1_000_000n;
const CENT = 10_000n;

/** `text` cut to `max` characters (code points), ending in "…" when it was longer. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + ELLIPSIS;
}

function group(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * An amount with its unit: points "+86 pts", USDC (6 decimals) "+16.00 USDC", cut (never rounded up)
 * to the cent. `signed` adds "+" to a positive amount (a net change).
 */
export function formatAmount(mode: Mode, amount: bigint, signed: boolean): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const sign = neg ? '-' : signed && abs > 0n ? '+' : '';
  if (mode === 'free') return `${sign}${group(abs)} pts`;
  const cents = ((abs % USDC_UNIT) / CENT).toString().padStart(2, '0');
  return `${sign}${group(abs / USDC_UNIT)}.${cents} USDC`;
}

const MODE_LABEL: Record<Mode, string> = { free: 'Free', stakes: 'Stakes' };

/** What a message renders from: its copy variant, the placeholder values and the path it opens. */
export interface Prepared {
  variant: string;
  values: NotificationValues;
  path: string;
  /** `outcome`: append "The next question is live." (push) or its paragraph and link (email). */
  nextLive: boolean;
}

interface ShareRow {
  option_index: 0 | 1 | null;
  tally_json: string | null;
}

/** The player's side's share of the valid entries ("38%"), from the mode's current tally. */
async function shareOf(
  db: D1Database,
  roundId: string,
  mode: Mode,
  userId: string,
  side: 'win' | 'loss',
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT e.option_index, s.tally_json FROM entries e
       LEFT JOIN settlements s ON s.round_id = e.round_id AND s.mode = e.mode AND s.superseded_at IS NULL
       WHERE e.round_id = ?1 AND e.mode = ?2 AND e.user_id = ?3 AND e.valid = 1
       LIMIT 1`,
    )
    .bind(roundId, mode, userId)
    .first<ShareRow>();
  if (!row || row.option_index === null || row.tally_json === null) return null;
  const tally = JSON.parse(row.tally_json) as [{ headcount: number }, { headcount: number }];
  const count = tally[row.option_index].headcount;
  const total = tally[0].headcount + tally[1].headcount;
  if (total <= 0 || count <= 0) return null;
  return formatShare(count, total, side);
}

/**
 * The variant, values and path for `msg` sent to `userId`, or null when it can't be rendered (an
 * outcome whose entry or tally is gone, a round without its question): logged and dropped by the
 * consumer, since a retry can't fix it.
 */
export async function prepare(
  db: D1Database,
  msg: NotifyMessage,
  userId: string,
): Promise<Prepared | null> {
  const base = { nextLive: false };
  switch (msg.event) {
    case 'question_live': {
      const row = await db
        .prepare(
          'SELECT q.prompt FROM rounds r JOIN questions q ON q.id = r.question_id WHERE r.id = ?1',
        )
        .bind(msg.payload.roundId)
        .first<{ prompt: string }>();
      if (!row) return null;
      return { ...base, variant: 'default', values: { question: row.prompt }, path: '/' };
    }
    case 'closing_soon':
      return { ...base, variant: 'default', values: {}, path: '/' };
    case 'outcome': {
      const p = msg.payload;
      const path = `/r/${p.roundId}`;
      const nextLive = p.nextRoundId !== null;
      const values: NotificationValues = { mode: MODE_LABEL[p.mode] };
      if (p.result === 'refund') {
        values.refundLine = REFUND_LINES[(p.refundReason ?? 1) as RefundReason];
        return { variant: 'refund', values, path, nextLive };
      }
      if (p.result === 'void') return { variant: 'void', values, path, nextLive };
      const share = await shareOf(db, p.roundId, p.mode, userId, p.result);
      if (share === null) return null;
      values.share = share;
      if (p.result === 'loss') return { variant: 'loss', values, path, nextLive };
      if (p.amount === null) return { variant: 'win_no_amount', values, path, nextLive };
      values.amount = formatAmount(p.mode, BigInt(p.amount), true);
      return { variant: 'win', values, path, nextLive };
    }
    case 'payout_claimable':
      return {
        ...base,
        variant: 'default',
        values: { payout: formatAmount('stakes', BigInt(msg.payload.amount), false) },
        path: '/claims',
      };
    case 'refunded':
      return {
        ...base,
        variant: msg.payload.mode,
        values: {
          mode: MODE_LABEL[msg.payload.mode],
          refundLine: REFUND_LINES[msg.payload.refundReason as RefundReason],
        },
        path: msg.payload.mode === 'stakes' ? '/claims' : `/r/${msg.payload.roundId}`,
      };
    case 'question_used':
      return {
        ...base,
        variant: msg.payload.stage,
        values: {},
        path: `/r/${msg.payload.roundId}`,
      };
    case 'streak_at_risk':
      return {
        ...base,
        variant: 'default',
        values: { streak: String(msg.payload.strayStreak) },
        path: '/',
      };
    case 'question_edited':
      return { ...base, variant: 'default', values: {}, path: '/queue' };
    case 'question_rejected':
      // The push body is the reason alone, cut to the push limit (owner, Oct 16, 2026).
      return {
        ...base,
        variant: 'default',
        values: { reason: clip(msg.payload.reason, PUSH_LIMITS.body) },
        path: '/queue',
      };
    case 'security_notice':
      return { ...base, variant: msg.payload.kind, values: {}, path: '/settings' };
  }
}

/** The copy for `channel`, or null when the event isn't sent there. */
export function renderCopy<C extends NotificationChannel>(
  channel: C,
  event: NotifyMessage['event'],
  prepared: Prepared,
): ChannelCopy<C> | null {
  const table = NOTIFICATION_COPY[event][channel] as Record<string, PushCopy | EmailCopy> | null;
  if (!table) return null;
  const template = table[prepared.variant];
  if (!template) throw new RangeError(`no ${channel} copy for ${event}/${prepared.variant}`);
  const fill = (s: string) => fillCopy(s, prepared.values);
  if (channel === 'email') {
    const t = template as EmailCopy;
    const email: EmailCopy = {
      subject: fill(t.subject),
      preheader: fill(t.preheader),
      heading: fill(t.heading),
      body: fill(t.body),
      cta: fill(t.cta),
    };
    return email as ChannelCopy<C>;
  }
  const t = template as PushCopy;
  const tail = prepared.nextLive ? ` ${OUTCOME_NEXT_LIVE}` : '';
  const push: PushCopy = {
    title: clip(fill(t.title), PUSH_LIMITS.title),
    body: clip(fill(t.body), PUSH_LIMITS.body - tail.length) + tail,
  };
  return push as ChannelCopy<C>;
}
