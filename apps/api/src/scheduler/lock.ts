// Question lock (spec "Round lifecycle" › Scheduling and the lock row; "Question pipeline" › House
// questions; "Sealed picks" › Free mode specifics). At opensAt − 6 h the round's question and config
// are frozen into `rounds` in one D1 batch, with its `round_modes` rows; after that nothing in the
// round can change (the `rounds_locked_immutable` trigger, migration 0005). The onchain halves (Stakes
// `createRound`, the Free lock leaf) and `RoundDO.init` follow in src/scheduler/tick.ts.
//
// W8-A (decisions C5 and E4, Oct 12, 2026): the Stakes `creator` and `payoutAddress` are resolved
// together at lock (src/questions/creator.ts); a daily round with no usable question and an empty
// house backlog is closed unlocked, so that game day has no daily round; a lock that used a house
// question checks the backlog (src/questions/backlog.ts); and the author of a daily round's question
// is sent `question_used` (stage `scheduled`).
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  NotifyMessageSchema,
  QuestionOptionSchema,
  freeConfigHash,
  gameDayOf,
  newUlid,
  questionHash,
  roundKey,
  type LockedConfig,
  type Mode,
  type RoundKind,
  type RoundStatus,
} from '@flocked/shared';
import {
  beaconTime,
  checkTargetRound,
  firstRoundAtOrAfter,
  isDailyClose,
  type DrandChain,
  type TargetRoundError,
} from '@flocked/tlock';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import type { EscrowRoundConfig } from '../chain/operator.js';
import type { AnchorLockItem, LockedRound } from '../do/types.js';
import type { Env } from '../env.js';
import { raiseAlert } from '../lib/alert.js';
import { log } from '../lib/log.js';
import { checkHouseBacklog } from '../questions/backlog.js';
import { TREASURY_CREATOR, resolveCreator, type CreatorResolution } from '../questions/creator.js';
import { HOUR_MS } from '../rounds/schedule.js';

/** The question lock: 6 hours before `opensAt`. */
export const LOCK_LEAD_MS = 6 * HOUR_MS;
/** A repeated schedule-gap alert for the same round waits this long. */
export const GAP_ALERT_EVERY_MS = HOUR_MS;

export interface RoundRow {
  id: string;
  kind: RoundKind;
  room_id: string | null;
  question_id: string | null;
  opens_at: number;
  closes_at: number;
  beacon_round: number | null;
  status: RoundStatus;
  locked_at: number | null;
  config_json: string | null;
}

export interface ModeRow {
  mode: Mode;
  status: string;
  chain_round_id: string | null;
  lock_tx: string | null;
}

export interface QuestionRow {
  id: string;
  author_user_id: string | null;
  prompt: string;
  options_json: string;
  status: string;
}

export type GapReason =
  | 'no_round'
  | 'no_question'
  | 'no_house_question'
  | 'no_daily_round'
  | 'invalid_config'
  | 'stakes_create_round_failed'
  | 'lock_leaf_failed';

/**
 * `refused` with `no_house_question` is the lock that found nothing to lock and closed its game day
 * (no daily round); `no_daily_round` answers every later call for that closed, unlocked round.
 */
export type LockOutcome =
  | { status: 'locked'; houseFill: boolean }
  | { status: 'already_locked' }
  | { status: 'refused'; reason: GapReason | TargetRoundError; detail?: string };

const OptionsSchema = z.tuple([QuestionOptionSchema, QuestionOptionSchema]);

/** Usable question statuses for a round; `rejected` and `submitted` are not. */
const USABLE = new Set(['queued', 'scheduled', 'used']);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A schedule gap (ALERT-6): an `audit_log` row (system) every time, and ALERT_SCHEDULE_GAP at most
 * once per round and reason per hour, so a gap that persists keeps paging without flooding. Only the
 * rows that alerted (`alerted: true`) count for the hour: a gap seen every minute would otherwise
 * always find the previous minute's row and page once only.
 */
export async function recordGap(
  env: Pick<Env, 'DB' | 'ANALYTICS' | 'ENVIRONMENT'>,
  t: number,
  target: string,
  reason: GapReason,
  data: Record<string, unknown> = {},
): Promise<boolean> {
  const recent = await env.DB.prepare(
    "SELECT 1 FROM audit_log WHERE action = 'schedule_gap' AND target = ?1 AND json_extract(data_json, '$.reason') = ?2 AND json_extract(data_json, '$.alerted') = 1 AND created_at > ?3 LIMIT 1",
  )
    .bind(target, reason, t - GAP_ALERT_EVERY_MS)
    .first();
  const alert = !recent;
  await env.DB.prepare(
    "INSERT INTO audit_log (id, actor, actor_user_id, action, target, data_json, created_at) VALUES (?1, 'system', NULL, 'schedule_gap', ?2, ?3, ?4)",
  )
    .bind(
      newUlid(t),
      target,
      JSON.stringify({ reason, ...data, ...(alert ? { alerted: true } : {}) }),
      t,
    )
    .run();
  if (!alert) return false;
  raiseAlert(env, 'ALERT_SCHEDULE_GAP', { target, reason, ...data });
  return true;
}

async function question(db: D1Database, id: string): Promise<QuestionRow | null> {
  return db
    .prepare('SELECT id, author_user_id, prompt, options_json, status FROM questions WHERE id = ?1')
    .bind(id)
    .first<QuestionRow>();
}

/** The top house question in the backlog (author null, queued): highest score, then oldest. */
export async function topHouseQuestion(db: D1Database): Promise<QuestionRow | null> {
  return db
    .prepare(
      "SELECT id, author_user_id, prompt, options_json, status FROM questions WHERE author_user_id IS NULL AND status = 'queued' ORDER BY score DESC, created_at ASC, id ASC LIMIT 1",
    )
    .first<QuestionRow>();
}

/** `questionHash` of a stored question (prompt and both options). */
export function questionHashOf(q: QuestionRow): Hex {
  const options = OptionsSchema.parse(JSON.parse(q.options_json));
  return questionHash({ prompt: q.prompt, options });
}

/**
 * The config to freeze. Before lock, `config_json` may hold a draft (an admin's per-round config); a
 * round without one gets the launch defaults with Free only (Stakes is enabled per round, behind its
 * launch gates). A daily round's Free creator award goes to the question's author (null for house).
 * Stakes `creator` and `payoutAddress` are set together from `creator` (decision C5): the author's
 * payout wallet in both when it resolved (src/questions/creator.ts; daily rounds only), else the
 * draft's creator (the treasury) and null. A draft's own payoutAddress is never kept. Reads publish
 * both from here, never from the author's current prefs (O4).
 */
export function configToLock(
  r: RoundRow,
  q: QuestionRow,
  creator: CreatorResolution = TREASURY_CREATOR,
): LockedConfig {
  const draft = r.config_json
    ? (JSON.parse(r.config_json) as Record<string, unknown>)
    : {
        beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
        free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
      };
  const free = draft.free as Record<string, unknown> | undefined;
  if (free) {
    draft.free = { ...free, awardRecipient: r.kind === 'daily' ? q.author_user_id : null };
  }
  const stakes = draft.stakes as Record<string, unknown> | undefined;
  if (stakes) {
    const author = r.kind === 'daily' && q.author_user_id !== null ? creator : TREASURY_CREATOR;
    draft.stakes =
      author.creator !== null
        ? { ...stakes, creator: author.creator, payoutAddress: author.payoutAddress }
        : { ...stakes, payoutAddress: null };
  }
  return LockedConfigSchema.parse(draft);
}

/**
 * The beacon round for the config, or why the timing is refused. Every lock runs the target-round
 * check (spec: required for any non-default close or `beaconDelay`); a daily round at the default
 * close is also checked to close at 21:00 New York on its game day.
 */
export function lockTiming(
  chain: DrandChain,
  r: RoundRow,
  config: LockedConfig,
  t: number,
): { ok: true; beaconRound: number } | { ok: false; reason: TargetRoundError | 'invalid_config' } {
  if (r.closes_at % 1000 !== 0 || r.opens_at % 1000 !== 0) {
    return { ok: false, reason: 'invalid_config' };
  }
  const closesAt = r.closes_at / 1000;
  const beaconRound = firstRoundAtOrAfter(chain, closesAt + config.beaconDelay);
  const defaultClose = r.kind === 'daily' && isDailyClose(closesAt, gameDayOf(closesAt));
  const check = checkTargetRound({
    chain,
    closesAt,
    beaconDelay: config.beaconDelay,
    beaconRound,
    now: Math.floor(t / 1000),
    ...(defaultClose ? { dailyClose: { gameDay: gameDayOf(closesAt) } } : {}),
  });
  return check.ok ? { ok: true, beaconRound } : check;
}

/**
 * A daily round at its lock with no usable question and an empty house backlog: that game day has
 * no daily round (spec "Question pipeline" › House questions; decision E4). The round is closed
 * while unlocked, which is final: the tick locks only `scheduled` rounds and the lock's own update
 * requires it, `ensureDueRounds` finds the row and creates nothing, and every read of a round
 * requires `locked_at`. The admin is alerted (ALERT-6) once, by the call that closed it.
 */
async function closeNoRoundDay(env: Env, r: RoundRow, t: number): Promise<void> {
  const res = await env.DB.prepare(
    "UPDATE rounds SET status = 'closed' WHERE id = ?1 AND locked_at IS NULL AND status = 'scheduled'",
  )
    .bind(r.id)
    .run();
  if (res.meta.changes !== 1) return;
  const gameDay = gameDayOf(Math.floor(r.closes_at / 1000));
  log.warn('no_daily_round', { roundId: r.id, gameDay });
  await recordGap(env, t, r.id, 'no_daily_round', { gameDay, opensAt: r.opens_at });
}

/** `question_used` (stage `scheduled`) to the author of a daily round's question. Never throws. */
async function enqueueQuestionUsed(
  env: Pick<Env, 'QUEUE_NOTIFY'>,
  r: RoundRow,
  q: QuestionRow,
): Promise<void> {
  try {
    const body = NotifyMessageSchema.parse({
      event: 'question_used',
      userId: q.author_user_id,
      dedupeKey: `question_used:${q.id}:scheduled`,
      payload: { questionId: q.id, stage: 'scheduled', roundId: r.id },
    });
    await env.QUEUE_NOTIFY.send(body);
  } catch (err) {
    log.error('question_used_enqueue_failed', {
      roundId: r.id,
      questionId: q.id,
      error: message(err),
    });
  }
}

/**
 * Locks one round at its question lock: picks the question (filling a gap with the top house
 * question and alerting, or closing a daily round's game day when there is none), freezes the
 * config, and creates its `round_modes` rows, all in one D1 batch that applies only while the round
 * is unlocked and scheduled. Idempotent: a locked round is left as it is.
 */
export async function lockRound(
  env: Env,
  chain: DrandChain,
  r: RoundRow,
  t: number,
): Promise<LockOutcome> {
  if (r.locked_at !== null) return { status: 'already_locked' };
  // Only a no-round day closes an unlocked round (closeNoRoundDay).
  if (r.status === 'closed') return { status: 'refused', reason: 'no_daily_round' };
  const db = env.DB;

  let q = r.question_id ? await question(db, r.question_id) : null;
  let houseFill = false;
  if (!q || !USABLE.has(q.status)) {
    if (r.kind !== 'daily') {
      await recordGap(env, t, r.id, 'no_question', { kind: r.kind });
      return { status: 'refused', reason: 'no_question' };
    }
    q = await topHouseQuestion(db);
    if (!q) {
      await closeNoRoundDay(env, r, t);
      return { status: 'refused', reason: 'no_house_question' };
    }
    houseFill = true;
  }

  let config: LockedConfig;
  let qHash: Hex;
  try {
    config = configToLock(r, q);
    qHash = questionHashOf(q);
  } catch (err) {
    const detail = message(err);
    await recordGap(env, t, r.id, 'invalid_config', { detail });
    return { status: 'refused', reason: 'invalid_config', detail };
  }
  const timing = lockTiming(chain, r, config, t);
  if (!timing.ok) {
    await recordGap(env, t, r.id, 'invalid_config', { detail: timing.reason });
    return { status: 'refused', reason: timing.reason };
  }

  // Stakes on a daily round's authored question: who receives the creator fee (decision C5).
  const authored = r.kind === 'daily' && q.author_user_id !== null;
  let creator: CreatorResolution | null = null;
  if (config.stakes && authored) {
    creator = await resolveCreator(env, q, t);
    if (creator.creator !== null) {
      try {
        config = configToLock(r, q, creator);
      } catch (err) {
        const detail = message(err);
        await recordGap(env, t, r.id, 'invalid_config', { detail });
        return { status: 'refused', reason: 'invalid_config', detail };
      }
    }
  }

  const modes: Mode[] = [];
  if (config.free) modes.push('free');
  if (config.stakes) modes.push('stakes');
  const lockedHere =
    'EXISTS (SELECT 1 FROM rounds WHERE id = ?1 AND locked_at = ?2 AND question_id = ?3)';
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE rounds SET question_id = ?2, beacon_round = ?3, config_json = ?4, locked_at = ?5 WHERE id = ?1 AND locked_at IS NULL AND status = 'scheduled'",
      )
      .bind(r.id, q.id, timing.beaconRound, JSON.stringify(config), t),
    ...modes.map((mode) =>
      db
        .prepare(
          `INSERT INTO round_modes (round_id, mode, status) SELECT ?1, ?4, 'pending' WHERE ${lockedHere} ON CONFLICT DO NOTHING`,
        )
        .bind(r.id, t, q.id, mode),
    ),
    db
      .prepare(`UPDATE questions SET status = 'used' WHERE id = ?3 AND ${lockedHere}`)
      .bind(r.id, t, q.id),
  ];
  if (creator) {
    // Who receives the creator fee and, for the treasury, which check failed (no addresses here:
    // the locked config has them).
    const data = {
      questionId: q.id,
      authorUserId: q.author_user_id,
      creator: creator.creator !== null ? 'author' : 'treasury',
      failed: creator.failed,
    };
    stmts.push(
      db
        .prepare(
          `INSERT INTO audit_log (id, actor, actor_user_id, action, target, data_json, created_at) SELECT ?4, 'system', NULL, 'stakes_creator', ?1, ?5, ?2 WHERE ${lockedHere}`,
        )
        .bind(r.id, t, q.id, newUlid(t), JSON.stringify(data)),
    );
  }
  const results = await db.batch(stmts);
  // Locked meanwhile, or closed as a no-round day by an overlapping tick.
  if ((results[0] as D1Result).meta.changes !== 1) return { status: 'already_locked' };

  log.info('round_locked', {
    roundId: r.id,
    questionId: q.id,
    modes,
    houseFill,
    qHash,
    ...(creator
      ? { stakesCreator: creator.creator !== null ? 'author' : 'treasury', failed: creator.failed }
      : {}),
  });
  if (q.author_user_id === null) {
    try {
      if (houseFill) {
        await recordGap(env, t, r.id, 'no_question', { filledWith: q.id, opensAt: r.opens_at });
      }
      await checkHouseBacklog(env, t);
    } catch (err) {
      log.error('house_question_alert_failed', { roundId: r.id, error: message(err) });
    }
  } else if (authored) {
    await enqueueQuestionUsed(env, r, q);
  }
  return { status: 'locked', houseFill };
}

/** The frozen config of a locked round. */
export function lockedConfigOf(r: RoundRow): LockedConfig {
  if (r.locked_at === null || r.config_json === null) throw new Error('round is not locked');
  return LockedConfigSchema.parse(JSON.parse(r.config_json));
}

/** The Free lock leaf (`FlockedAnchor.lock` item): configHash = freeConfigHash(locked config). */
export function freeLockItem(r: RoundRow, q: QuestionRow): AnchorLockItem {
  const config = lockedConfigOf(r);
  return {
    roundKey: roundKey(r.id, 'free'),
    roundId: r.id,
    mode: 'free',
    closesAtSec: r.closes_at / 1000,
    beaconRound: r.beacon_round as number,
    questionHash: questionHashOf(q),
    configHash: freeConfigHash(config),
  };
}

/** `RoundConfig` for Stakes `createRound` (every parameter; spec "Round lifecycle" › Scheduling). */
export function escrowConfigOf(r: RoundRow, q: QuestionRow): EscrowRoundConfig {
  const s = lockedConfigOf(r).stakes;
  if (!s) throw new Error('the locked config has no Stakes mode');
  return {
    opensAt: r.opens_at / 1000,
    closesAt: r.closes_at / 1000,
    beaconRound: r.beacon_round as number,
    stake: BigInt(s.stake),
    feeBps: s.feeBps,
    creatorBps: s.creatorBps,
    capMultiple: s.capMultiple,
    minEntrants: s.minEntrants,
    creator: s.creator as Address,
    questionHash: questionHashOf(q),
  };
}

/**
 * What `RoundDO.init` receives. Built the same way on every call (key order included), because a
 * repeated init must match the first. A voided mode is left out.
 */
export function lockedRoundOf(chain: DrandChain, r: RoundRow, modes: ModeRow[]): LockedRound {
  const beaconRound = r.beacon_round as number;
  const live = (['free', 'stakes'] as const).filter((m) =>
    modes.some((x) => x.mode === m && x.status !== 'voided'),
  );
  const locked: LockedRound = {
    roundId: r.id,
    kind: r.kind,
    roomId: r.room_id,
    questionId: r.question_id as string,
    opensAt: r.opens_at,
    closesAt: r.closes_at,
    beaconRound,
    beaconTimeSec: beaconTime(chain, beaconRound),
    config: lockedConfigOf(r),
    modes: live,
  };
  const stakes = modes.find((m) => m.mode === 'stakes');
  if (live.includes('stakes') && stakes?.chain_round_id)
    locked.chainRoundId = stakes.chain_round_id;
  return locked;
}
