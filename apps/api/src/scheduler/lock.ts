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
//
// W8-D (spec "Profiles, leaderboards and rooms" › Rooms): room rounds. A closed room's round closes
// unlocked, quietly (no alert, no gap row). A mirror room's round takes the question of the daily
// round of the same slot once that one is locked (it waits, quietly, while the daily is unlocked, and
// closes quietly on a day with no daily round); a custom room's round takes the owner's question and
// closes quietly without one. A room round locks with `minEntrants` = 3 (the room minimum) in every
// mode and no creator award; it keeps a draft's Stakes section only while `rooms.stakes.enabled` and
// `mode.stakes.enabled` are both on, and is Free only otherwise. The tick locks a slot's daily round
// before its room rounds.
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  NotifyMessageSchema,
  QuestionOptionSchema,
  ROOMS_STAKES_ENABLED_KEY,
  ROOM_MIN_QUALIFYING_ENTRANTS,
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
import { CONFIG_KEYS } from '../personhood/config-store.js';
import { checkHouseBacklog } from '../questions/backlog.js';
import { TREASURY_CREATOR, resolveCreator, type CreatorResolution } from '../questions/creator.js';
import { HOUR_MS } from '../rounds/schedule.js';

/** The question lock: 6 hours before `opensAt`. */
export const LOCK_LEAD_MS = 6 * HOUR_MS;
/** A repeated schedule-gap alert for the same round waits this long. */
export const GAP_ALERT_EVERY_MS = HOUR_MS;

/** The `rounds` columns read into a RoundRow. */
export const ROUND_COLUMNS =
  'id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json';

/**
 * Attempts at one lock whose round or question changed after it was read (W8-F1 M1, L1): a room
 * question stored, an Assign or a Reject committing between the read and the lock's batch.
 */
const LOCK_ATTEMPTS = 3;

/** What a lock attempt returns when its round or question changed after it was read. */
const STALE = Symbol('stale');

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
 * Why a room round was closed at its lock without a round (quietly: no alert, no gap row). `no_question`
 * is a custom room's round with no usable question; `no_daily_round` a mirror room's round on a day
 * with no daily round.
 */
export type RoomCloseReason = 'room_closed' | 'no_question' | 'no_daily_round';

/**
 * `refused` with `no_house_question` is the lock that found nothing to lock and closed its game day
 * (no daily round); `no_daily_round` answers every later call for that closed, unlocked round (a room
 * round's included). `refused` with `awaiting_daily` is a mirror room's round whose daily round isn't
 * locked yet: no alert, and the next tick retries. `closed` is a room round closed unlocked by this
 * call (final).
 */
export type LockOutcome =
  | { status: 'locked'; houseFill: boolean }
  | { status: 'already_locked' }
  | { status: 'closed'; reason: RoomCloseReason }
  | { status: 'refused'; reason: GapReason | TargetRoundError | 'awaiting_daily'; detail?: string };

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

/**
 * The top house question in the backlog (author null, queued, not a room's own question): highest
 * score, then oldest.
 */
export async function topHouseQuestion(db: D1Database): Promise<QuestionRow | null> {
  return db
    .prepare(
      "SELECT id, author_user_id, prompt, options_json, status FROM questions WHERE author_user_id IS NULL AND status = 'queued' AND room_id IS NULL ORDER BY score DESC, created_at ASC, id ASC LIMIT 1",
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
 *
 * A room round (W8-D) always has Free (the defaults when the draft has no Free section), with no
 * creator award; it keeps the draft's Stakes section only when `roomStakes` (`roomStakesEnabled`) is
 * true; and every mode it keeps locks `minEntrants` = ROOM_MIN_QUALIFYING_ENTRANTS (3).
 */
export function configToLock(
  r: RoundRow,
  q: QuestionRow,
  creator: CreatorResolution = TREASURY_CREATOR,
  roomStakes = false,
): LockedConfig {
  const draft = r.config_json
    ? (JSON.parse(r.config_json) as Record<string, unknown>)
    : {
        beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
        free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
      };
  const room = r.kind === 'room';
  if (room) {
    draft.free ??= { ...LOCKED_CONFIG_DEFAULTS.free };
    if (!roomStakes) delete draft.stakes;
  }
  const roomMin = room ? { minEntrants: ROOM_MIN_QUALIFYING_ENTRANTS } : {};
  const free = draft.free as Record<string, unknown> | undefined;
  if (free) {
    draft.free = {
      ...free,
      ...roomMin,
      awardRecipient: r.kind === 'daily' ? q.author_user_id : null,
    };
  }
  const stakes = draft.stakes as Record<string, unknown> | undefined;
  if (stakes) {
    const author = r.kind === 'daily' && q.author_user_id !== null ? creator : TREASURY_CREATOR;
    draft.stakes =
      author.creator !== null
        ? { ...stakes, ...roomMin, creator: author.creator, payoutAddress: author.payoutAddress }
        : { ...stakes, ...roomMin, payoutAddress: null };
  }
  return LockedConfigSchema.parse(draft);
}

/** The round's draft has a Stakes section (an unparsable draft is refused by configToLock). */
function draftHasStakes(r: RoundRow): boolean {
  if (!r.config_json) return false;
  try {
    const draft = JSON.parse(r.config_json) as unknown;
    return typeof draft === 'object' && draft !== null && 'stakes' in draft;
  } catch {
    return false;
  }
}

/** A JSON `true` in `config.value_json`; anything else (or no row) is off. */
function jsonTrue(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    return JSON.parse(value) === true;
  } catch {
    return false;
  }
}

/**
 * Whether a room round may keep a Stakes mode: `rooms.stakes.enabled` (off by default) and the Stakes
 * kill switch `mode.stakes.enabled` both on. Stakes is still enabled per round by the draft.
 */
export async function roomStakesEnabled(db: D1Database): Promise<boolean> {
  const { results } = await db
    .prepare('SELECT key, value_json FROM config WHERE key IN (?1, ?2)')
    .bind(ROOMS_STAKES_ENABLED_KEY, CONFIG_KEYS.stakesEnabled)
    .all<{ key: string; value_json: string }>();
  const on = (key: string) => jsonTrue(results.find((x) => x.key === key)?.value_json);
  return on(ROOMS_STAKES_ENABLED_KEY) && on(CONFIG_KEYS.stakesEnabled);
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
async function closeNoRoundDay(env: Env, r: RoundRow, t: number): Promise<boolean> {
  // Only while no question was assigned since the read (W8-F1 L1): otherwise the lock retries.
  const res = await env.DB.prepare(
    "UPDATE rounds SET status = 'closed' WHERE id = ?1 AND locked_at IS NULL AND status = 'scheduled' AND question_id IS ?2",
  )
    .bind(r.id, r.question_id)
    .run();
  if (res.meta.changes !== 1) return false;
  const gameDay = gameDayOf(Math.floor(r.closes_at / 1000));
  log.warn('no_daily_round', { roundId: r.id, gameDay });
  await recordGap(env, t, r.id, 'no_daily_round', { gameDay, opensAt: r.opens_at });
  return true;
}

/**
 * Closes a room round unlocked at its lock, without a round: final, like a no-round day, but quiet
 * (no alert and no gap row: an empty custom room or a closed room is not a schedule fault). `closed`
 * when this call closed it. It applies only while the round's `question_id` is still the one read,
 * and `q` (the unusable question read, if any) still has the status read, so a question stored or
 * approved after the read is locked by the retry instead (W8-F1 M1); STALE otherwise, also when an
 * overlapping call locked or closed it first.
 */
async function closeRoomRound(
  db: D1Database,
  r: RoundRow,
  reason: RoomCloseReason,
  q: QuestionRow | null = null,
): Promise<LockOutcome | typeof STALE> {
  const res = await db
    .prepare(
      "UPDATE rounds SET status = 'closed' WHERE id = ?1 AND locked_at IS NULL AND status = 'scheduled' " +
        'AND question_id IS ?2 AND (?3 IS NULL OR EXISTS (SELECT 1 FROM questions WHERE id = ?3 AND status = ?4))',
    )
    .bind(r.id, r.question_id, q?.id ?? null, q?.status ?? null)
    .run();
  if (res.meta.changes !== 1) return STALE;
  log.info('room_round_closed_unlocked', { roundId: r.id, roomId: r.room_id, reason });
  return { status: 'closed', reason };
}

interface RoomRow {
  question_source: 'daily' | 'custom';
  closed_at: number | null;
}

/**
 * A room round's question at its lock: a mirror room's is the same slot's locked daily question, a
 * custom room's the owner's (`rounds.question_id`, a usable question of that room). Otherwise what
 * the lock returns instead: a quiet close, or (mirror, daily not locked yet) a refusal to retry.
 */
async function roomQuestion(
  db: D1Database,
  r: RoundRow,
): Promise<{ q: QuestionRow } | { outcome: LockOutcome | typeof STALE }> {
  const room = await db
    .prepare('SELECT question_source, closed_at FROM rooms WHERE id = ?1')
    .bind(r.room_id)
    .first<RoomRow>();
  if (!room || room.closed_at !== null) {
    return { outcome: await closeRoomRound(db, r, 'room_closed') };
  }
  if (room.question_source === 'daily') {
    const daily = await db
      .prepare(
        "SELECT question_id, status, locked_at FROM rounds WHERE kind = 'daily' AND closes_at = ?1",
      )
      .bind(r.closes_at)
      .first<{ question_id: string | null; status: string; locked_at: number | null }>();
    if (daily && daily.locked_at !== null && daily.question_id !== null) {
      const q = await question(db, daily.question_id);
      if (q) return { q };
    }
    if (daily && daily.locked_at === null && daily.status === 'closed') {
      return { outcome: await closeRoomRound(db, r, 'no_daily_round') };
    }
    // The daily round isn't locked yet (the tick locks it first; a missing one is the gap check's).
    return { outcome: { status: 'refused', reason: 'awaiting_daily' } };
  }
  const q = r.question_id
    ? await db
        .prepare(
          'SELECT id, author_user_id, prompt, options_json, status FROM questions WHERE id = ?1 AND room_id = ?2',
        )
        .bind(r.question_id, r.room_id)
        .first<QuestionRow>()
    : null;
  if (!q || !USABLE.has(q.status)) {
    return { outcome: await closeRoomRound(db, r, 'no_question', q) };
  }
  return { q };
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
 * question and alerting, or closing a daily round's game day when there is none; for a room round,
 * see the header), freezes the config, and creates its `round_modes` rows, all in one D1 batch that
 * applies only while the round is unlocked and scheduled. Idempotent: a locked round is left as it is.
 *
 * The batch also applies only while the round's `question_id` is still the one in `r` and the
 * question picked still has the status read (W8-F1 M1, L1): a room question stored, an Assign or a
 * Reject that commits after the read makes this attempt stale, and the lock re-reads the round and
 * tries again, so it never overwrites them. It throws after LOCK_ATTEMPTS (the next tick retries).
 */
export async function lockRound(
  env: Env,
  chain: DrandChain,
  r: RoundRow,
  t: number,
): Promise<LockOutcome> {
  let row = r;
  for (let attempt = 1; ; attempt++) {
    const outcome = await lockOnce(env, chain, row, t);
    if (outcome !== STALE) return outcome;
    const fresh = await env.DB.prepare(`SELECT ${ROUND_COLUMNS} FROM rounds WHERE id = ?1`)
      .bind(r.id)
      .first<RoundRow>();
    // Locked meanwhile, or closed by an overlapping tick.
    if (!fresh || fresh.locked_at !== null || fresh.status !== 'scheduled') {
      return { status: 'already_locked' };
    }
    if (attempt >= LOCK_ATTEMPTS) throw new Error(`round ${r.id} changed during its lock`);
    log.info('round_lock_retried', { roundId: r.id, attempt });
    row = fresh;
  }
}

async function lockOnce(
  env: Env,
  chain: DrandChain,
  r: RoundRow,
  t: number,
): Promise<LockOutcome | typeof STALE> {
  if (r.locked_at !== null) return { status: 'already_locked' };
  // Only a no-round day (closeNoRoundDay) or a room round's quiet close closes an unlocked round.
  if (r.status === 'closed') return { status: 'refused', reason: 'no_daily_round' };
  const db = env.DB;

  let q: QuestionRow | null;
  let houseFill = false;
  let roomStakes = false;
  if (r.kind === 'room') {
    const found = await roomQuestion(db, r);
    if ('outcome' in found) return found.outcome;
    q = found.q;
    if (draftHasStakes(r)) roomStakes = await roomStakesEnabled(db);
  } else {
    q = r.question_id ? await question(db, r.question_id) : null;
    if (!q || !USABLE.has(q.status)) {
      q = await topHouseQuestion(db);
      if (!q) {
        if (!(await closeNoRoundDay(env, r, t))) return STALE;
        return { status: 'refused', reason: 'no_house_question' };
      }
      houseFill = true;
    }
  }

  let config: LockedConfig;
  let qHash: Hex;
  try {
    config = configToLock(r, q, TREASURY_CREATOR, roomStakes);
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
        "UPDATE rounds SET question_id = ?2, beacon_round = ?3, config_json = ?4, locked_at = ?5 WHERE id = ?1 AND locked_at IS NULL AND status = 'scheduled' " +
          'AND question_id IS ?6 AND EXISTS (SELECT 1 FROM questions WHERE id = ?2 AND status = ?7)',
      )
      .bind(r.id, q.id, timing.beaconRound, JSON.stringify(config), t, r.question_id, q.status),
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
  // Locked or closed meanwhile, or its question changed since the read: lockRound re-reads.
  if ((results[0] as D1Result).meta.changes !== 1) return STALE;

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
  if (r.kind !== 'daily') return { status: 'locked', houseFill };
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
