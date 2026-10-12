// Round reads (spec "API": GET /rounds/today, /rounds/:id, /rounds?before=&limit=), shaped by
// packages/shared/src/api/rounds.ts (wave-6 pinned read models).
//
// Reveal gating: a mode's settlement (tally, winner, pools) is read only once that mode's
// `revealed_at` is set. Settlement writes some of it earlier — Stakes writes its record and the
// entries' outcomes before `propose`, and `revealed_at` is set only when the indexer sees
// `OutcomeProposed` — so every per-option field here is read through `revealedAt`, never through
// the presence of a row. Entrant counts and pools are aggregates and are public throughout.
import {
  LockedConfigSchema,
  QuestionOptionSchema,
  dailyClosesAt,
  freeConfigHash,
  gameDayOf,
  questionHash,
  type Mode,
  type ModeStatus,
  type RoundArchiveItem,
  type RoundConfigWire,
  type RoundKind,
  type RoundModeView,
  type RoundStatus,
  type RoundView,
  type RoundsArchiveResponse,
  type SettlementView,
} from '@flocked/shared';
import { z } from 'zod';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';

const OptionsSchema = z.tuple([QuestionOptionSchema, QuestionOptionSchema]);

/** Default and maximum page size of GET /rounds. */
export const ARCHIVE_DEFAULT_LIMIT = 20;

/** Mode statuses that end a mode (`round_modes.final_at` is set). */
const FINAL: ReadonlySet<ModeStatus> = new Set(['settled', 'refunded', 'voided']);

interface RoundRow {
  id: string;
  kind: RoundKind;
  room_id: string | null;
  question_id: string;
  opens_at: number;
  closes_at: number;
  beacon_round: number;
  status: RoundStatus;
  locked_at: number;
  config_json: string;
  q_prompt: string;
  q_options_json: string;
  q_category: string;
  q_author: string | null;
  a_handle: string | null;
  a_display_name: string | null;
  a_avatar_url: string | null;
  a_prefs_json: string | null;
}

/** Locked rounds only: before the lock a round's question and config can still change. */
const ROUND_SELECT = `
  SELECT r.id, r.kind, r.room_id, r.question_id, r.opens_at, r.closes_at, r.beacon_round, r.status,
         r.locked_at, r.config_json, q.prompt AS q_prompt, q.options_json AS q_options_json,
         q.category AS q_category, q.author_user_id AS q_author, a.handle AS a_handle,
         a.display_name AS a_display_name, a.avatar_url AS a_avatar_url, a.prefs_json AS a_prefs_json
  FROM rounds r JOIN questions q ON q.id = r.question_id
  LEFT JOIN users a ON a.id = q.author_user_id
  WHERE r.locked_at IS NOT NULL`;

interface ModeRow {
  round_id: string;
  mode: Mode;
  status: ModeStatus;
  refund_reason: number | null;
  chain_round_id: string | null;
  revealed_at: number | null;
  claims_open_at: number | null;
  final_at: number | null;
}

interface SettlementRow {
  round_id: string;
  mode: Mode;
  proposal_seq: number;
  outcome: SettlementView['outcome'];
  formula_version: number;
  tally_json: string;
  winners_json: string | null;
  loss_pool: number;
  fee: number;
  creator_fee: number;
  distributable: number;
  rebate_pool: number;
  dust: number;
  payout_root: string | null;
  bundle_hash: string | null;
  settled_at: number | null;
  tx_hash: string | null;
}

/** Entrant count and pool per mode. */
export interface ModeCounts {
  entrantCount: number;
  pool: string;
}
type CountsByMode = Partial<Record<Mode, ModeCounts>>;

const placeholders = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `?${i + from}`).join(', ');

async function modeRows(db: D1Database, ids: string[]): Promise<ModeRow[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT round_id, mode, status, refund_reason, chain_round_id, revealed_at, claims_open_at,
              final_at
       FROM round_modes WHERE round_id IN (${placeholders(ids.length)})`,
    )
    .bind(...ids)
    .all<ModeRow>();
  return results;
}

/**
 * The current settlement record of each (round, mode) whose `revealed_at` is set. The join on
 * `revealed_at` is the gate: an unrevealed mode's record is never read.
 */
async function revealedSettlements(db: D1Database, ids: string[]): Promise<SettlementRow[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT s.round_id, s.mode, s.proposal_seq, s.outcome, s.formula_version, s.tally_json,
              s.winners_json, s.loss_pool, s.fee, s.creator_fee, s.distributable, s.rebate_pool,
              s.dust, s.payout_root, s.bundle_hash, s.settled_at, s.tx_hash
       FROM settlements s JOIN round_modes m ON m.round_id = s.round_id AND m.mode = s.mode
       WHERE s.round_id IN (${placeholders(ids.length)}) AND s.superseded_at IS NULL
         AND m.revealed_at IS NOT NULL`,
    )
    .bind(...ids)
    .all<SettlementRow>();
  return results;
}

/** Entrant counts and pools from D1 (settled rounds, the archive, and when a RoundDO can't answer). */
async function d1Counts(db: D1Database, ids: string[]): Promise<Map<string, CountsByMode>> {
  const out = new Map<string, CountsByMode>();
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT round_id, mode, COUNT(*) AS n, CAST(COALESCE(SUM(stake), 0) AS TEXT) AS pool
       FROM entries WHERE round_id IN (${placeholders(ids.length)}) GROUP BY round_id, mode`,
    )
    .bind(...ids)
    .all<{ round_id: string; mode: Mode; n: number; pool: string }>();
  for (const r of results) {
    const m = out.get(r.round_id) ?? {};
    m[r.mode] = { entrantCount: r.n, pool: r.pool };
    out.set(r.round_id, m);
  }
  return out;
}

/** Live counts from the round's RoundDO (open rounds), else D1's. */
async function liveCounts(env: Env, roundId: string): Promise<CountsByMode> {
  try {
    const state = await env.ROUND.get(env.ROUND.idFromName(roundId)).getState();
    const out: CountsByMode = {};
    for (const [mode, s] of Object.entries(state.modes) as [Mode, ModeCounts][]) {
      out[mode] = { entrantCount: s.entrantCount, pool: s.pool };
    }
    return out;
  } catch (err) {
    log.warn('read_counts_fallback', { roundId, error: String(err) });
    return (await d1Counts(env.DB, [roundId])).get(roundId) ?? {};
  }
}

const tallyOf = (json: string): SettlementView['tally'] =>
  JSON.parse(json) as SettlementView['tally'];

function settlementView(s: SettlementRow): SettlementView {
  const winners = s.winners_json ? (JSON.parse(s.winners_json) as { winner?: 0 | 1 | null }) : null;
  return {
    proposalSeq: s.proposal_seq,
    outcome: s.outcome,
    formulaVersion: s.formula_version,
    winningOption: s.outcome === 'settled' ? (winners?.winner ?? null) : null,
    tally: tallyOf(s.tally_json),
    lossPool: String(s.loss_pool),
    fee: String(s.fee),
    creatorFee: String(s.creator_fee),
    distributable: String(s.distributable),
    rebatePool: String(s.rebate_pool),
    dust: String(s.dust),
    payoutRoot: s.payout_root,
    bundleHash: s.bundle_hash,
    txHash: s.tx_hash,
    settledAt: s.settled_at,
  };
}

function modeView(
  m: ModeRow,
  counts: ModeCounts | undefined,
  settlement: SettlementRow | undefined,
): RoundModeView {
  const revealed = m.revealed_at !== null;
  return {
    status: m.status,
    entrantCount: counts?.entrantCount ?? 0,
    pool: counts?.pool ?? '0',
    chainRoundId: m.mode === 'stakes' ? m.chain_round_id : null,
    revealedAt: m.revealed_at,
    claimsOpenAt: m.mode === 'stakes' ? m.claims_open_at : null,
    finalAt: m.final_at,
    refundReason: m.refund_reason,
    settlement: revealed && settlement ? settlementView(settlement) : null,
  };
}

const lower = (a: string) => a.toLowerCase() as `0x${string}`;

/** The published config: the locked config, plus the Stakes fields clients check onchain. */
function configWire(r: RoundRow, chainRoundId: string | null): RoundConfigWire {
  const c = LockedConfigSchema.parse(JSON.parse(r.config_json));
  const out: RoundConfigWire = { beaconDelay: c.beaconDelay, overrides: [] };
  if (c.free) {
    // The lock leaf's config hash, recomputed from the stored config.
    out.free = { ...c.free, configHash: freeConfigHash(c) };
  }
  if (c.stakes) {
    const options = OptionsSchema.parse(JSON.parse(r.q_options_json));
    const prefs = r.a_prefs_json
      ? (JSON.parse(r.a_prefs_json) as { creator_payout_wallet?: string | null })
      : null;
    const creator = lower(c.stakes.creator);
    // `creator` is the author's payout wallet or the treasury: it is the author's when it is the
    // wallet the author named.
    const payout = prefs?.creator_payout_wallet ? lower(prefs.creator_payout_wallet) : null;
    out.stakes = {
      chainRoundId: chainRoundId ?? '0',
      opensAt: Math.floor(r.opens_at / 1000),
      closesAt: Math.floor(r.closes_at / 1000),
      beaconRound: r.beacon_round,
      stake: c.stakes.stake,
      feeBps: c.stakes.feeBps,
      creatorBps: c.stakes.creatorBps,
      capMultiple: c.stakes.capMultiple,
      minEntrants: c.stakes.minEntrants,
      creator,
      questionHash: questionHash({ prompt: r.q_prompt, options }),
      authorHandle: r.q_author ? r.a_handle : null,
      payoutAddress: r.q_author && payout === creator ? creator : null,
    };
  }
  return out;
}

/** Unix seconds of drand round `r` on this deployment's chain. */
function beaconTimeOf(env: Pick<Env, 'DRAND_GENESIS' | 'DRAND_PERIOD'>, r: number): number {
  return Number(env.DRAND_GENESIS) + (r - 1) * Number(env.DRAND_PERIOD);
}

function roundView(
  env: Env,
  r: RoundRow,
  modes: ModeRow[],
  counts: CountsByMode,
  settlements: SettlementRow[],
): RoundView {
  const view: RoundView = {
    id: r.id,
    kind: r.kind,
    roomId: r.room_id,
    gameDay: gameDayOf(Math.floor(r.closes_at / 1000)),
    status: r.status,
    question: {
      id: r.question_id,
      prompt: r.q_prompt,
      options: OptionsSchema.parse(JSON.parse(r.q_options_json)),
      category: r.q_category as RoundView['question']['category'],
      author: r.q_author
        ? {
            id: r.q_author,
            handle: r.a_handle,
            displayName: r.a_display_name,
            avatarUrl: r.a_avatar_url,
          }
        : null,
    },
    opensAt: Math.floor(r.opens_at / 1000),
    closesAt: Math.floor(r.closes_at / 1000),
    beaconRound: r.beacon_round,
    beaconTime: beaconTimeOf(env, r.beacon_round),
    lockedAt: r.locked_at,
    config: null,
    modes: {},
  };
  const stakes = modes.find((m) => m.mode === 'stakes');
  view.config = configWire(r, stakes?.chain_round_id ?? null);
  for (const m of modes) {
    const s = settlements.find((x) => x.mode === m.mode);
    view.modes[m.mode] = modeView(m, counts[m.mode], s);
  }
  return view;
}

async function roundRow(db: D1Database, roundId: string): Promise<RoundRow | null> {
  return db.prepare(`${ROUND_SELECT} AND r.id = ?1`).bind(roundId).first<RoundRow>();
}

/** GET /rounds/:id's round (the caller has passed `roundAccess`), or null when not locked. */
export async function readRound(env: Env, roundId: string): Promise<RoundView | null> {
  const r = await roundRow(env.DB, roundId);
  if (!r) return null;
  const [modes, settlements] = await Promise.all([
    modeRows(env.DB, [r.id]),
    revealedSettlements(env.DB, [r.id]),
  ]);
  const live = modes.some((m) => !FINAL.has(m.status)) && r.status !== 'closed';
  const counts = live
    ? await liveCounts(env, r.id)
    : ((await d1Counts(env.DB, [r.id])).get(r.id) ?? {});
  return roundView(env, r, modes, counts, settlements);
}

/**
 * GET /rounds/today: the daily round open at `t` (epoch ms; null in a schedule gap), and the
 * previous daily round while any of its modes is still revealing or settling.
 */
export async function readToday(
  env: Env,
  t: number,
): Promise<{ round: RoundView | null; previousRoundId: string | null }> {
  const open = await env.DB.prepare(
    `${ROUND_SELECT} AND r.kind = 'daily' AND r.opens_at <= ?1 AND r.closes_at > ?1
     ORDER BY r.closes_at LIMIT 1`,
  )
    .bind(t)
    .first<RoundRow>();
  const prev = await env.DB.prepare(
    `SELECT r.id FROM rounds r WHERE r.kind = 'daily' AND r.locked_at IS NOT NULL AND r.closes_at <= ?1
       AND EXISTS (SELECT 1 FROM round_modes m WHERE m.round_id = r.id
                   AND m.status NOT IN ('settled', 'refunded', 'voided'))
       AND r.closes_at = (SELECT MAX(closes_at) FROM rounds WHERE kind = 'daily'
                          AND locked_at IS NOT NULL AND closes_at <= ?1)`,
  )
    .bind(t)
    .first<{ id: string }>();
  const round = open ? await readRound(env, open.id) : null;
  return { round, previousRoundId: prev?.id ?? null };
}

/** The open daily round's ID and opensAt at `t` (for the first-visit grant), or null. */
export async function openDailyRound(
  db: D1Database,
  t: number,
): Promise<{ id: string; opensAt: number } | null> {
  const row = await db
    .prepare(
      `SELECT id, opens_at FROM rounds WHERE kind = 'daily' AND locked_at IS NOT NULL
         AND opens_at <= ?1 AND closes_at > ?1 ORDER BY closes_at LIMIT 1`,
    )
    .bind(t)
    .first<{ id: string; opens_at: number }>();
  return row && { id: row.id, opensAt: row.opens_at };
}

/**
 * GET /rounds?before=&limit=: closed daily rounds whose game day is before `before` (exclusive;
 * every closed round without it), newest first. Room rounds are never listed.
 */
export async function readArchive(
  env: Env,
  q: { before?: string; limit?: number },
): Promise<RoundsArchiveResponse> {
  const limit = q.limit ?? ARCHIVE_DEFAULT_LIMIT;
  // Every round of game day D closes before 21:00 New York on D + 1, and a daily round of an
  // earlier day closes before 21:00 on `before`; the game day is checked exactly below. The bound
  // also takes in `before`'s own daily round (one per game day), which the check drops: one row more
  // than `limit + 1` is read so that `rows` still tells whether another page exists.
  const bound = q.before ? dailyClosesAt(q.before) * 1000 : Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare(
    `${ROUND_SELECT} AND r.kind = 'daily' AND r.status = 'closed' AND r.closes_at <= ?1
     ORDER BY r.closes_at DESC LIMIT ?2`,
  )
    .bind(bound, limit + 2)
    .all<RoundRow>();
  const rows = results.filter(
    (r) => !q.before || gameDayOf(Math.floor(r.closes_at / 1000)) < q.before,
  );
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.id);
  const [modes, settlements, counts] = await Promise.all([
    modeRows(env.DB, ids),
    revealedSettlements(env.DB, ids),
    d1Counts(env.DB, ids),
  ]);
  const rounds: RoundArchiveItem[] = page.map((r) => {
    const v = roundView(
      env,
      r,
      modes.filter((m) => m.round_id === r.id),
      counts.get(r.id) ?? {},
      settlements.filter((s) => s.round_id === r.id),
    );
    const item: RoundArchiveItem = {
      id: v.id,
      gameDay: v.gameDay,
      question: v.question,
      modes: {},
    };
    for (const [mode, m] of Object.entries(v.modes) as [Mode, RoundModeView][]) {
      item.modes[mode] = {
        status: m.status,
        entrantCount: m.entrantCount,
        pool: m.pool,
        winningOption: m.settlement?.winningOption ?? null,
        tally: m.settlement?.tally ?? null,
        refundReason: m.refundReason,
      };
    }
    return item;
  });
  const last = page[page.length - 1];
  const more = rows.length > limit;
  return {
    rounds,
    nextBefore: more && last ? gameDayOf(Math.floor(last.closes_at / 1000)) : null,
  };
}
