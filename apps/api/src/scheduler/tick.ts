// The scheduler's minute tick (spec "Architecture": Scheduler; "Round lifecycle" › the lock row). Each
// tick, idempotently:
//   1. checks that the open game day's daily round exists, and the next one once its lock is due; a
//      missing one is a schedule gap (ALERT-6): it alerts and creates the round;
//   2. locks every round whose question lock (opensAt − 6 h) has passed (src/scheduler/lock.ts);
//   3. for each locked round still before close: Stakes `createRound` through src/chain/operator.ts
//      (storing `chain_round_id` from the receipt), and the Free lock leaf through the AnchorDO (one
//      `submitLock` call for every round still waiting for its leaf);
//   4. calls `RoundDO.init` for every locked round that hasn't closed and whose modes are ready, so
//      the RoundDO opens it at `opensAt` (a repeated init is how a stalled alarm chain restarts);
//   5. moves every pending operator cancellation one step (W4-F1 T4), starting any whose first
//      attempt failed (W5-F1 C4).
// A Stakes round that can't be created before `opensAt` (the contract refuses after it) has its
// Stakes mode voided and alerts; Free goes on. A `createRound` still pending then is cancelled, so it
// can't land late or hold up the operator's nonce.
import { chainFromEnv, type DrandChain } from '@flocked/tlock';
import {
  cancelCreateRound,
  createRound,
  driveCancellations,
  type OperatorDeps,
} from '../chain/operator.js';
import { ANCHOR_SINGLETON } from '../do/anchor-do.js';
import type { AnchorLockItem } from '../do/types.js';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';
import { insertDailyRound, slotsAhead } from './create.js';
import {
  LOCK_LEAD_MS,
  escrowConfigOf,
  freeLockItem,
  lockRound,
  lockedRoundOf,
  recordGap,
  type LockOutcome,
  type ModeRow,
  type QuestionRow,
  type RoundRow,
} from './lock.js';

export interface SchedulerDeps {
  operator?: OperatorDeps;
}

export interface TickReport {
  /** Daily rounds that were missing when due (a gap) and were created now. */
  createdForGap: string[];
  locks: Record<string, LockOutcome['status'] | `refused:${string}`>;
  /** Stakes `createRound` results by round. */
  stakes: Record<string, string>;
  /** Rounds whose Free lock leaf went to the AnchorDO. */
  lockLeaves: string[];
  initialized: string[];
  /** Operator cancellations moved this tick, by purpose (T4). */
  cancellations: Record<string, string>;
}

export type SchedulerEnv = Env;

export function drandChainOf(env: Env): DrandChain {
  return chainFromEnv({
    DRAND_CHAIN_HASH: env.DRAND_CHAIN_HASH,
    DRAND_PUBLIC_KEY: env.DRAND_PUBLIC_KEY,
    DRAND_GENESIS: env.DRAND_GENESIS,
    DRAND_PERIOD: env.DRAND_PERIOD,
  });
}

const ROUND_COLUMNS =
  'id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Step 1: the daily rounds that must exist by now (open now, or past their lock). */
async function ensureDueRounds(env: Env, t: number, report: TickReport): Promise<void> {
  for (const slot of slotsAhead(t, LOCK_LEAD_MS)) {
    const exists = await env.DB.prepare(
      "SELECT 1 FROM rounds WHERE kind = 'daily' AND closes_at = ?1",
    )
      .bind(slot.closesAt)
      .first();
    if (exists) continue;
    const id = await insertDailyRound(env.DB, slot);
    if (id) report.createdForGap.push(id);
    await recordGap(env, t, `daily:${slot.gameDay}`, 'no_round', {
      gameDay: slot.gameDay,
      createdRoundId: id,
    });
  }
}

async function modesOf(db: D1Database, roundId: string): Promise<ModeRow[]> {
  const { results } = await db
    .prepare(
      'SELECT mode, status, chain_round_id, lock_tx FROM round_modes WHERE round_id = ?1 ORDER BY mode',
    )
    .bind(roundId)
    .all<ModeRow>();
  return results;
}

async function questionOf(db: D1Database, r: RoundRow): Promise<QuestionRow> {
  const q = await db
    .prepare('SELECT id, author_user_id, prompt, options_json, status FROM questions WHERE id = ?1')
    .bind(r.question_id)
    .first<QuestionRow>();
  if (!q) throw new Error(`round ${r.id}: locked question ${r.question_id} is missing`);
  return q;
}

/**
 * Step 3 for Stakes: `createRound` until `chain_round_id` is stored. Returns whether the Stakes mode
 * is settled (created, voided or absent), so the round can be initialised.
 */
async function ensureStakesRound(
  env: Env,
  deps: SchedulerDeps,
  r: RoundRow,
  q: QuestionRow,
  stakes: ModeRow,
  t: number,
  report: TickReport,
): Promise<boolean> {
  if (stakes.status === 'voided' || stakes.chain_round_id) return true;
  const result = await createRound(env, deps.operator ?? {}, {
    roundId: r.id,
    cfg: escrowConfigOf(r, q),
  });
  report.stakes[r.id] = result.status;
  if (result.status === 'mined' && result.chainRoundId) {
    await env.DB.prepare(
      "UPDATE round_modes SET chain_round_id = ?2, lock_tx = ?3 WHERE round_id = ?1 AND mode = 'stakes' AND chain_round_id IS NULL",
    )
      .bind(r.id, result.chainRoundId, result.txHash)
      .run();
    log.info('stakes_round_created', { roundId: r.id, chainRoundId: result.chainRoundId });
    return true;
  }
  const error = result.status === 'refused' ? result.error : result.status;
  if (result.status === 'pending' && t < r.opens_at) return false;
  if (result.status === 'cancelled') return true; // voided below, when its cancellation started
  // Refused or reverted, or still pending at opensAt: the contract no longer accepts it after
  // opensAt, so the Stakes mode is voided and Free goes on.
  if (result.status !== 'reverted' && t < r.opens_at) {
    await recordGap(env, t, r.id, 'stakes_create_round_failed', { error });
    return false;
  }
  await env.DB.prepare(
    "UPDATE round_modes SET status = 'voided', final_at = ?2 WHERE round_id = ?1 AND mode = 'stakes' AND status = 'pending' AND chain_round_id IS NULL",
  )
    .bind(r.id, t)
    .run();
  await recordGap(env, t, r.id, 'stakes_create_round_failed', { error, voided: true });
  if (result.status === 'pending') {
    // Abandoned: replace it at its nonce (the sweep in schedulerTick finishes the cancellation).
    try {
      await cancelCreateRound(env, deps.operator ?? {}, r.id);
    } catch (err) {
      log.error('create_round_cancel_failed', { roundId: r.id, error: message(err) });
    }
  }
  return true;
}

/** One scheduler tick (see the header). Never throws for one round's failure. */
export async function schedulerTick(env: Env, deps: SchedulerDeps = {}): Promise<TickReport> {
  const t = now(env);
  const chain = drandChainOf(env);
  const report: TickReport = {
    createdForGap: [],
    locks: {},
    stakes: {},
    lockLeaves: [],
    initialized: [],
    cancellations: {},
  };
  await ensureDueRounds(env, t, report);

  // Step 2: lock what is due.
  const { results: due } = await env.DB.prepare(
    `SELECT ${ROUND_COLUMNS} FROM rounds WHERE locked_at IS NULL AND status = 'scheduled' AND opens_at - ?2 <= ?1 AND closes_at > ?1 ORDER BY opens_at, id`,
  )
    .bind(t, LOCK_LEAD_MS)
    .all<RoundRow>();
  for (const r of due) {
    try {
      const outcome = await lockRound(env, chain, r, t);
      report.locks[r.id] =
        outcome.status === 'refused' ? `refused:${outcome.reason}` : outcome.status;
    } catch (err) {
      log.error('round_lock_failed', { roundId: r.id, error: message(err) });
    }
  }

  // Steps 3 and 4 for every live locked round.
  const { results: live } = await env.DB.prepare(
    `SELECT ${ROUND_COLUMNS} FROM rounds WHERE locked_at IS NOT NULL AND status IN ('scheduled', 'open') ORDER BY opens_at, id`,
  ).all<RoundRow>();
  const leaves: AnchorLockItem[] = [];
  const ready: { r: RoundRow; modes: ModeRow[] }[] = [];
  for (const r of live) {
    try {
      const q = await questionOf(env.DB, r);
      let modes = await modesOf(env.DB, r.id);
      const stakes = modes.find((m) => m.mode === 'stakes');
      let stakesReady = true;
      if (stakes && r.closes_at > t) {
        stakesReady = await ensureStakesRound(env, deps, r, q, stakes, t, report);
        modes = await modesOf(env.DB, r.id);
      }
      const free = modes.find((m) => m.mode === 'free');
      if (free && free.lock_tx === null && r.closes_at > t) {
        leaves.push(freeLockItem(r, q));
        report.lockLeaves.push(r.id);
      }
      if (stakesReady) ready.push({ r, modes });
    } catch (err) {
      log.error('round_lock_step_failed', { roundId: r.id, error: message(err) });
    }
  }

  if (leaves.length > 0) {
    try {
      const anchor = env.ANCHOR.get(env.ANCHOR.idFromName(ANCHOR_SINGLETON));
      const ack = await anchor.submitLock(leaves);
      log.info('lock_leaves_submitted', {
        queued: ack.queued.length,
        alreadyAnchored: ack.alreadyAnchored.length,
      });
    } catch (err) {
      log.error('lock_leaves_submit_failed', { error: message(err) });
    }
  }

  for (const { r, modes } of ready) {
    try {
      const locked = lockedRoundOf(chain, r, modes);
      await env.ROUND.get(env.ROUND.idFromName(r.id)).init(locked);
      report.initialized.push(r.id);
    } catch (err) {
      log.error('round_init_failed', { roundId: r.id, error: message(err) });
    }
  }

  // Step 5.
  try {
    report.cancellations = await driveCancellations(env, deps.operator ?? {});
  } catch (err) {
    log.error('operator_cancellations_failed', { error: message(err) });
  }
  return report;
}
