// The WebSocket `state` snapshot (spec "Real-time and the reveal": full snapshot on connect), built
// by the rules GET /rounds/:id follows (src/read/rounds.ts), so the two always agree:
//   - the round's status and times from D1 (`rounds`, locked rounds only);
//   - each mode's status, `revealed_at`, `claims_open_at` and refund reason from D1 `round_modes`,
//     which is the record: the RoundDO keeps a finalized Stakes mode at `settle_proposed` (W6-Z);
//   - entrant counts and pools from the RoundDO while the round is live, else from D1 `entries`;
//   - a mode's result only through `revealed_at`: the settlement row is joined on it, never read
//     by its mere presence (Stakes writes its record before the proposal is confirmed onchain).
import {
  TallySchema,
  WsStateMessageSchema,
  type Mode,
  type ModeStatus,
  type RoundStatus,
  type WsModeSnapshot,
  type WsStateMessage,
} from '@flocked/shared';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';

interface RoundRow {
  status: RoundStatus;
  opens_at: number;
  closes_at: number;
  beacon_round: number;
}

interface ModeRow {
  mode: Mode;
  status: ModeStatus;
  refund_reason: number | null;
  revealed_at: number | null;
  claims_open_at: number | null;
  /** The current settlement, joined only when `revealed_at` is set. */
  outcome: string | null;
  tally_json: string | null;
  winners_json: string | null;
}

type Counts = Partial<Record<Mode, { entrantCount: number; pool: string }>>;

const FINAL: ReadonlySet<ModeStatus> = new Set(['settled', 'refunded', 'voided']);

/** Unix seconds of drand round `r` (as src/read/rounds.ts computes it). */
const beaconTimeOf = (env: Env, r: number) =>
  Number(env.DRAND_GENESIS) + (r - 1) * Number(env.DRAND_PERIOD);

async function d1Counts(db: D1Database, roundId: string): Promise<Counts> {
  const { results } = await db
    .prepare(
      `SELECT mode, COUNT(*) AS n, CAST(COALESCE(SUM(stake), 0) AS TEXT) AS pool
       FROM entries WHERE round_id = ?1 GROUP BY mode`,
    )
    .bind(roundId)
    .all<{ mode: Mode; n: number; pool: string }>();
  return Object.fromEntries(results.map((r) => [r.mode, { entrantCount: r.n, pool: r.pool }]));
}

/** The RoundDO's live counters; D1's when the RoundDO can't answer (as GET /rounds/:id does). */
async function liveCounts(env: Env, roundId: string): Promise<Counts> {
  try {
    const state = await env.ROUND.get(env.ROUND.idFromName(roundId)).getState();
    const out: Counts = {};
    for (const [mode, s] of Object.entries(state.modes) as [Mode, Counts[Mode]][]) {
      if (s) out[mode] = { entrantCount: s.entrantCount, pool: s.pool };
    }
    return out;
  } catch (err) {
    log.warn('ws_counts_fallback', { roundId, error: String(err) });
    return d1Counts(env.DB, roundId);
  }
}

function result(m: ModeRow): WsModeSnapshot['result'] {
  if (m.revealed_at === null || m.outcome !== 'settled' || m.tally_json === null) return null;
  const winner = (JSON.parse(m.winners_json ?? '{}') as { winner?: 0 | 1 | null }).winner;
  if (winner !== 0 && winner !== 1) return null;
  return { winningOption: winner, tally: TallySchema.parse(JSON.parse(m.tally_json)) };
}

/**
 * The `state` message for a locked round, or null when there is no such locked round. `serverTime`
 * is set here; a caller that keeps the snapshot sets it again when it sends it.
 */
export async function roundSnapshot(env: Env, roundId: string): Promise<WsStateMessage | null> {
  const db = env.DB;
  const [round, modes] = await db.batch([
    db
      .prepare(
        `SELECT status, opens_at, closes_at, beacon_round FROM rounds
         WHERE id = ?1 AND locked_at IS NOT NULL`,
      )
      .bind(roundId),
    db
      .prepare(
        `SELECT m.mode, m.status, m.refund_reason, m.revealed_at, m.claims_open_at,
                s.outcome, s.tally_json, s.winners_json
         FROM round_modes m
         LEFT JOIN settlements s ON s.round_id = m.round_id AND s.mode = m.mode
           AND s.superseded_at IS NULL AND m.revealed_at IS NOT NULL
         WHERE m.round_id = ?1`,
      )
      .bind(roundId),
  ]);
  const r = (round?.results as RoundRow[] | undefined)?.[0];
  if (!r) return null;
  const rows = (modes?.results ?? []) as ModeRow[];
  const live = rows.some((m) => !FINAL.has(m.status)) && r.status !== 'closed';
  const counts = live ? await liveCounts(env, roundId) : await d1Counts(db, roundId);
  const out: WsStateMessage['modes'] = {};
  for (const m of rows) {
    out[m.mode] = {
      status: m.status,
      entrantCount: counts[m.mode]?.entrantCount ?? 0,
      pool: counts[m.mode]?.pool ?? '0',
      revealedAt: m.revealed_at,
      claimsOpenAt: m.mode === 'stakes' ? m.claims_open_at : null,
      refundReason: m.refund_reason,
      result: result(m),
    };
  }
  // The schema refuses a result without `revealedAt`: the last check before anything is sent.
  return WsStateMessageSchema.parse({
    type: 'state',
    roundId,
    status: r.status,
    opensAt: Math.floor(r.opens_at / 1000),
    closesAt: Math.floor(r.closes_at / 1000),
    beaconRound: r.beacon_round,
    beaconTime: beaconTimeOf(env, r.beacon_round),
    serverTime: now(env),
    modes: out,
  });
}
