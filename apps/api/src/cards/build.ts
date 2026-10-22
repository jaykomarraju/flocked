// One `CardModel` out of D1 (spec "Share cards and distribution" › Card content). The renderer takes
// it from here and knows nothing about the database.
//
// Reveal gating ("API" › Reveal gating) is the first rule: nothing per-option is read before the
// mode's `revealed_at`, so before the reveal a result card does not exist at all (null) and a teaser
// never reads the pick. A mode refunded before its reveal has no tally to show, so its card carries
// the entrant count instead of the bars (refund rules 4, 6, 7 and 8; screens.md "Refund cards").
import {
  formatShare,
  gameDayOf,
  type CardKind,
  type EntryResult,
  type Mode,
  type ModeStatus,
  type RoundKind,
} from '@flocked/shared';
import type { Env } from '../env.js';
import {
  CARD_GOT_FLOCKED,
  CARD_REFUNDED_TITLE,
  CARD_TEASER_LINE,
  CARD_UNFLOCKED,
  cardRefundLine,
  metaLabel,
  playersLabel,
  refundKeepsSplit,
  refundSealed,
  roundLine,
  type CardModel,
  type CardOption,
} from './model.js';

export type CardsBuildEnv = Pick<Env, 'DB'>;

/** Which card to build. `userId` is required for `result` and `teaser`, absent for `round`. */
export interface CardTarget {
  roundId: string;
  mode: Mode;
  kind: CardKind;
  userId?: string;
}

/** A mode whose stake came back: its card shows no result, only why (`src/read/me.ts` REFUNDED). */
const REFUNDED: ReadonlySet<ModeStatus> = new Set(['refund_proposed', 'refunded', 'voided']);

interface RoundRow {
  kind: RoundKind;
  room_id: string | null;
  closes_at: number;
  prompt: string;
  options_json: string;
  status: ModeStatus;
  refund_reason: number | null;
  revealed_at: number | null;
}

interface SettlementRow {
  outcome: 'settled' | 'refunded' | 'voided';
  tally_json: string;
  winners_json: string | null;
}

interface EntryRow {
  option_index: number | null;
  valid: number | null;
  stake: number;
}

type Tally = [{ headcount: number }, { headcount: number }];

/** The two option labels from the question's stored options. */
function optionLabels(json: string): [string, string] {
  const options = JSON.parse(json) as { label: string }[];
  return [options[0]?.label ?? '', options[1]?.label ?? ''];
}

/** The split rows: headcounts as percentages, the minority winner, and the owner's pick. */
function splitOptions(
  labels: [string, string],
  tally: Tally,
  winner: 0 | 1 | null,
  picked: number | null,
): [CardOption, CardOption] {
  const counts = [tally[0].headcount, tally[1].headcount] as const;
  const total = counts[0] + counts[1];
  return [0, 1].map((i) => {
    const count = counts[i] as number;
    return {
      label: labels[i] as string,
      // The winning share rounds down and the losing share rounds up, so a winner never reads 50%.
      pct: total > 0 ? formatShare(count, total, winner === i ? 'win' : 'loss') : '0%',
      fill: total > 0 ? (100 * count) / total : 0,
      winner: winner === i,
      picked: picked === i,
    };
  }) as [CardOption, CardOption];
}

/** The player's result, as `GET /rounds/:id/me` classifies it (src/read/me.ts `resultOf`). */
function resultOf(
  r: RoundRow,
  s: SettlementRow | null,
  entry: EntryRow | null,
  winner: 0 | 1 | null,
): EntryResult | null {
  if (!entry) return null;
  const revealed = r.revealed_at !== null;
  if (revealed && entry.valid === 0) return 'void';
  if (REFUNDED.has(r.status)) return 'refund';
  if (!revealed || s === null) return null;
  if (s.outcome !== 'settled') return 'refund';
  return entry.option_index === winner ? 'win' : 'loss';
}

/** USDC (6 decimals) as the cards write it: "16.00", "1,234.50". */
export function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const cents = (units % 1_000_000n) / 10_000n;
  return `${whole.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
}

/** The gross return over the stake, to one decimal: "2.6x". */
export function formatMultiple(gross: bigint, stake: bigint): string {
  if (stake <= 0n) return '1.0x';
  const tenths = (gross * 10n) / stake;
  return `${tenths / 10n}.${tenths % 10n}x`;
}

/**
 * A win's value: points for Free, and for Stakes the amount only if the player asked for amounts on
 * their cards (spec "Card content"; `users.prefs_json` `show_card_amounts`, default off), else the
 * multiple. `gross` is the payout as the settlement wrote it, stake included.
 */
export function winValue(
  mode: Mode,
  gross: bigint,
  stake: bigint,
  showAmounts: boolean,
): { value: string; isAmount: boolean } {
  const net = gross > stake ? gross - stake : 0n;
  if (mode === 'free') return { value: `+${net.toLocaleString('en-US')} pts`, isAmount: false };
  if (!showAmounts) return { value: formatMultiple(gross, stake), isAmount: true };
  return { value: `+${formatUsdc(net)} USDC`, isAmount: true };
}

/**
 * The card for `target`, or null when there is none to draw yet: an unlocked or unknown round, a
 * result card before its mode's reveal (and before any refund), a round card with no tally, or a
 * player who never entered.
 */
export async function buildCardModel(
  env: CardsBuildEnv,
  target: CardTarget,
): Promise<CardModel | null> {
  const { roundId, mode, kind, userId } = target;
  const round = await env.DB.prepare(
    `SELECT r.kind, r.room_id, r.closes_at, q.prompt, q.options_json,
            m.status, m.refund_reason, m.revealed_at
     FROM rounds r
     JOIN questions q ON q.id = r.question_id
     JOIN round_modes m ON m.round_id = r.id AND m.mode = ?2
     WHERE r.id = ?1 AND r.locked_at IS NOT NULL`,
  )
    .bind(roundId, mode)
    .first<RoundRow>();
  if (!round) return null;

  const revealed = round.revealed_at !== null;
  const refunded = REFUNDED.has(round.status);
  if (kind !== 'teaser' && !revealed && !refunded) return null;

  const labels = optionLabels(round.options_json);
  // The label's date is the game day: the New York date the round closes on.
  const meta = metaLabel(mode, gameDayOf(Math.floor(round.closes_at / 1000)));
  const settlement = revealed
    ? await env.DB.prepare(
        `SELECT outcome, tally_json, winners_json FROM settlements
         WHERE round_id = ?1 AND mode = ?2 AND superseded_at IS NULL`,
      )
        .bind(roundId, mode)
        .first<SettlementRow>()
    : null;
  const tally = settlement ? (JSON.parse(settlement.tally_json) as Tally) : null;
  const winner =
    settlement?.outcome === 'settled' && settlement.winners_json
      ? ((JSON.parse(settlement.winners_json) as { winner?: 0 | 1 | null }).winner ?? null)
      : null;

  const base = {
    kind,
    meta,
    question: round.prompt,
    bars: false,
    outlines: false,
    count: null as string | null,
    sealed: false,
    streak: null as number | null,
    resultValue: null as string | null,
    resultAccent: false,
    resultIsAmount: false,
    note: null as string | null,
    handle: null as string | null,
  };

  if (kind === 'teaser') {
    // No per-option data and no pick, at any point in the round's life.
    const owner = userId ? await handleOf(env, userId) : null;
    return {
      ...base,
      options: [
        { label: labels[0], pct: null, fill: 0, winner: false, picked: false },
        { label: labels[1], pct: null, fill: 0, winner: false, picked: false },
      ],
      outlines: true,
      sealed: true,
      resultLabel: CARD_TEASER_LINE,
      pose: 'neutral',
      handle: owner,
    };
  }

  const entrants = await countEntries(env, roundId, mode);
  const keepsSplit =
    tally !== null && (settlement?.outcome === 'settled' || refundKeepsSplit(round.refund_reason));

  const entry =
    kind === 'result' && userId
      ? await env.DB.prepare(
          `SELECT option_index, valid, stake FROM entries
           WHERE round_id = ?1 AND mode = ?2 AND user_id = ?3`,
        )
          .bind(roundId, mode, userId)
          .first<EntryRow>()
      : null;
  if (kind === 'result' && !entry) return null;
  if (kind === 'round' && !keepsSplit && !refunded) return null;

  const options = keepsSplit
    ? splitOptions(labels, tally, winner, kind === 'result' ? (entry?.option_index ?? null) : null)
    : ([
        { label: labels[0], pct: null, fill: 0, winner: false, picked: false },
        { label: labels[1], pct: null, fill: 0, winner: false, picked: false },
      ] as [CardOption, CardOption]);

  const middle = keepsSplit
    ? { bars: true, count: null, sealed: false }
    : {
        bars: false,
        count: playersLabel(entrants),
        sealed: refundSealed(round.refund_reason),
      };

  if (kind === 'round') {
    const total = tally ? tally[0].headcount + tally[1].headcount : 0;
    const strayed = tally && winner !== null ? tally[winner].headcount : 0;
    return {
      ...base,
      ...middle,
      meta: `${meta} · ${playersLabel(entrants)}`,
      options,
      resultLabel: winner === null ? CARD_REFUNDED_TITLE : roundLine(strayed, total),
      note: winner === null ? cardRefundLine(round.refund_reason) : null,
      pose: 'neutral',
      handle: null,
    };
  }

  const result = resultOf(round, settlement, entry, winner);
  const owner = userId ? await ownerOf(env, userId) : null;
  const model: CardModel = {
    ...base,
    ...middle,
    options,
    resultLabel: CARD_REFUNDED_TITLE,
    pose: 'neutral',
    handle: owner?.handle ?? null,
  };
  if (result === 'win') {
    const gross = await payoutOf(env, roundId, mode, userId as string);
    const { value, isAmount } = winValue(
      mode,
      gross,
      BigInt(entry?.stake ?? 0),
      owner?.showAmounts === true,
    );
    return {
      ...model,
      resultLabel: CARD_UNFLOCKED,
      resultValue: value,
      resultAccent: true,
      resultIsAmount: isAmount,
      pose: 'smug',
      streak: await strayStreak(env, userId as string, mode),
    };
  }
  if (result === 'loss') {
    return { ...model, resultLabel: CARD_GOT_FLOCKED, pose: 'flock' };
  }
  // A refund, and a void entry in a settled mode (which has no rule of its own: its stake came
  // back, so the card is the refunded title with no why line).
  return { ...model, note: refunded ? cardRefundLine(round.refund_reason) : null };
}

async function countEntries(env: CardsBuildEnv, roundId: string, mode: Mode): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT count(*) AS n FROM entries WHERE round_id = ?1 AND mode = ?2',
  )
    .bind(roundId, mode)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The handle, which is NULL once the account is deleted (so its cards lose handle and avatar). */
async function handleOf(env: CardsBuildEnv, userId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT handle FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ handle: string | null }>();
  return row?.handle ?? null;
}

async function ownerOf(
  env: CardsBuildEnv,
  userId: string,
): Promise<{ handle: string | null; showAmounts: boolean } | null> {
  const row = await env.DB.prepare('SELECT handle, prefs_json FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ handle: string | null; prefs_json: string | null }>();
  if (!row) return null;
  let showAmounts: boolean;
  try {
    const prefs = JSON.parse(row.prefs_json ?? '{}') as { show_card_amounts?: unknown };
    showAmounts = prefs.show_card_amounts === true;
  } catch {
    showAmounts = false;
  }
  return { handle: row.handle, showAmounts };
}

/** The player's gross payout for the mode (stake included), as the settlement wrote it. */
async function payoutOf(
  env: CardsBuildEnv,
  roundId: string,
  mode: Mode,
  userId: string,
): Promise<bigint> {
  const row = await env.DB.prepare(
    `SELECT CAST(COALESCE(sum(amount), 0) AS TEXT) AS total FROM payouts
     WHERE round_id = ?1 AND mode = ?2 AND user_id = ?3 AND kind IN ('win', 'rebate')`,
  )
    .bind(roundId, mode, userId)
    .first<{ total: string }>();
  return BigInt(row?.total ?? '0');
}

/** The stray streak, shown as a pill from 2 up (spec "Card content"). */
async function strayStreak(env: CardsBuildEnv, userId: string, mode: Mode): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT stray_streak FROM user_stats WHERE user_id = ?1 AND mode = ?2',
  )
    .bind(userId, mode)
    .first<{ stray_streak: number }>();
  const streak = row?.stray_streak ?? 0;
  return streak >= 2 ? streak : null;
}
