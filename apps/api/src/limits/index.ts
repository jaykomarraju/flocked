// `PUT /me/limits` and `POST /me/limits/exclusion-lift` (spec "Compliance and responsible play" ›
// Responsible play; "API"; "Data model" `limits`).
//
// - Daily stake cap: a decrease takes effect at once (and drops any pending increase); an increase
//   waits 24 hours in `pending_cap`. Setting the same pending amount again keeps its timer; any
//   other raise restarts it. The cap in force is `effectiveDailyCap` (src/stakes/cap.ts), so a
//   raise that has waited out its 24 hours is the base for the next change.
// - Self-exclusion: 7 days, 30 days, 6 months or permanent. It can be started or lengthened (to a
//   later end, or to permanent), never shortened or ended. A permanent exclusion can be lifted only
//   on request 6 months after it started, and the lift takes effect after a 7-day cooling-off;
//   asking for permanent again during the cooling-off cancels the lift.
// - Suspended accounts may still lower their cap and exclude themselves; raising the cap and
//   lifting an exclusion are refused (`account_suspended`).
// Every change writes an `audit_log` row in the same batch.
import type { LimitsState, SetLimitsRequest } from '@flocked/shared';
import { limitsView } from '../auth/profile.js';
import type { Env } from '../env.js';
import { HttpError } from '../lib/errors.js';
import { abortIf, auditStatement, isGuardAbort } from '../identity/sql.js';
import { effectiveDailyCap } from '../stakes/cap.js';
import {
  CAP_RAISE_DELAY_MS,
  EXCLUSION_LIFT_AFTER_MONTHS,
  EXCLUSION_LIFT_COOLING_OFF_MS,
  addMonths,
  exclusionUntil,
} from './rules.js';

export interface LimitsRow {
  daily_stake_cap: number | null;
  pending_cap: number | null;
  pending_cap_effective_at: number | null;
  self_exclusion_started_at: number | null;
  self_exclusion_until: number | null;
  self_exclusion_permanent: number;
  exclusion_lift_requested_at: number | null;
  exclusion_lift_effective_at: number | null;
  question_block_until: number | null;
}

const EMPTY: LimitsRow = {
  daily_stake_cap: null,
  pending_cap: null,
  pending_cap_effective_at: null,
  self_exclusion_started_at: null,
  self_exclusion_until: null,
  self_exclusion_permanent: 0,
  exclusion_lift_requested_at: null,
  exclusion_lift_effective_at: null,
  question_block_until: null,
};

export async function loadLimits(db: D1Database, userId: string): Promise<LimitsRow | null> {
  return db.prepare('SELECT * FROM limits WHERE user_id = ?1').bind(userId).first<LimitsRow>();
}

/** A permanent exclusion that hasn't been lifted yet (a pending lift still counts). */
function permanentInForce(row: LimitsRow, t: number): boolean {
  return (
    row.self_exclusion_permanent === 1 &&
    (row.exclusion_lift_effective_at === null || row.exclusion_lift_effective_at > t)
  );
}

function timedInForce(row: LimitsRow, t: number): boolean {
  return row.self_exclusion_until !== null && row.self_exclusion_until > t;
}

/** The new cap columns for a request of `amount` (USDC base units). */
function capChange(
  row: LimitsRow,
  amount: bigint,
  t: number,
  suspended: boolean,
): Partial<LimitsRow> {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError('bad_request', 'That cap is too large');
  }
  const current = effectiveDailyCap(row, t);
  if (amount <= current) {
    // A decrease, or the cap in force again: immediate, and any pending increase is dropped.
    return { daily_stake_cap: Number(amount), pending_cap: null, pending_cap_effective_at: null };
  }
  if (suspended) throw new HttpError('account_suspended', 'This account is suspended');
  const sameRaise =
    row.pending_cap !== null &&
    BigInt(row.pending_cap) === amount &&
    row.pending_cap_effective_at !== null &&
    row.pending_cap_effective_at > t;
  return {
    daily_stake_cap: Number(current),
    pending_cap: Number(amount),
    pending_cap_effective_at: sameRaise ? row.pending_cap_effective_at : t + CAP_RAISE_DELAY_MS,
  };
}

/** The new exclusion columns for `period`, or an error for a shortening. */
function exclusionChange(
  row: LimitsRow,
  period: NonNullable<SetLimitsRequest['selfExclusion']>,
  t: number,
): Partial<LimitsRow> {
  const lifting = row.exclusion_lift_effective_at !== null && row.exclusion_lift_effective_at > t;
  if (permanentInForce(row, t)) {
    if (period !== 'permanent') {
      throw new HttpError(
        'exclusion_cannot_shorten',
        'A permanent self-exclusion cannot be shortened',
      );
    }
    // Permanent again: cancels a lift in its cooling-off period.
    return lifting ? { exclusion_lift_requested_at: null, exclusion_lift_effective_at: null } : {};
  }
  const until = exclusionUntil(period, t);
  const fresh = {
    self_exclusion_started_at: t,
    exclusion_lift_requested_at: null,
    exclusion_lift_effective_at: null,
  };
  if (until === null) {
    return { ...fresh, self_exclusion_until: null, self_exclusion_permanent: 1 };
  }
  if (timedInForce(row, t)) {
    const current = row.self_exclusion_until as number;
    if (until < current) {
      throw new HttpError(
        'exclusion_cannot_shorten',
        'Your self-exclusion already runs longer; it cannot be shortened',
      );
    }
    return { self_exclusion_until: until };
  }
  return { ...fresh, self_exclusion_until: until, self_exclusion_permanent: 0 };
}

function upsertStatement(db: D1Database, userId: string, row: LimitsRow): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO limits (user_id, daily_stake_cap, pending_cap, pending_cap_effective_at, ' +
        'self_exclusion_started_at, self_exclusion_until, self_exclusion_permanent, ' +
        'exclusion_lift_requested_at, exclusion_lift_effective_at, question_block_until) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT (user_id) DO UPDATE SET ' +
        'daily_stake_cap = excluded.daily_stake_cap, pending_cap = excluded.pending_cap, ' +
        'pending_cap_effective_at = excluded.pending_cap_effective_at, ' +
        'self_exclusion_started_at = excluded.self_exclusion_started_at, ' +
        'self_exclusion_until = excluded.self_exclusion_until, ' +
        'self_exclusion_permanent = excluded.self_exclusion_permanent, ' +
        'exclusion_lift_requested_at = excluded.exclusion_lift_requested_at, ' +
        'exclusion_lift_effective_at = excluded.exclusion_lift_effective_at',
    )
    .bind(
      userId,
      row.daily_stake_cap,
      row.pending_cap,
      row.pending_cap_effective_at,
      row.self_exclusion_started_at,
      row.self_exclusion_until,
      row.self_exclusion_permanent,
      row.exclusion_lift_requested_at,
      row.exclusion_lift_effective_at,
      row.question_block_until,
    );
}

/**
 * Writes `next` if `current` is still the stored row (a concurrent change answers 409), with an
 * audit row. The guard compares every column the change derived from.
 */
async function writeLimits(
  db: D1Database,
  userId: string,
  current: LimitsRow | null,
  next: LimitsRow,
  action: string,
  data: Record<string, unknown>,
  t: number,
): Promise<void> {
  const cols = Object.keys(EMPTY) as (keyof LimitsRow)[];
  const unchanged = current
    ? `EXISTS (SELECT 1 FROM limits WHERE user_id = ?1 AND ${cols.map((c, i) => `${c} IS ?${i + 2}`).join(' AND ')})`
    : 'NOT EXISTS (SELECT 1 FROM limits WHERE user_id = ?1)';
  const guard = abortIf(
    db,
    `NOT ${unchanged}`,
    userId,
    ...(current ? cols.map((c) => current[c]) : []),
  );
  try {
    await db.batch([
      guard,
      upsertStatement(db, userId, next),
      auditStatement(db, {
        actor: 'user',
        actorUserId: userId,
        action,
        target: userId,
        data,
        now: t,
      }),
    ]);
  } catch (err) {
    if (isGuardAbort(err)) {
      throw new HttpError('conflict', 'Your limits changed meanwhile; reload and try again');
    }
    throw err;
  }
}

export async function setLimits(
  env: Pick<Env, 'DB'>,
  userId: string,
  request: SetLimitsRequest,
  opts: { suspended: boolean },
  t: number,
): Promise<LimitsState> {
  const current = await loadLimits(env.DB, userId);
  let next: LimitsRow = { ...(current ?? EMPTY) };
  if (request.dailyStakeCap !== undefined) {
    next = { ...next, ...capChange(next, BigInt(request.dailyStakeCap), t, opts.suspended) };
  }
  if (request.selfExclusion !== undefined) {
    next = { ...next, ...exclusionChange(next, request.selfExclusion, t) };
  }
  await writeLimits(env.DB, userId, current, next, 'limits_set', { request, limits: next }, t);
  return limitsView(next, t);
}

/** Requests the lift of a permanent exclusion: 6 months after it started, effective 7 days later. */
export async function requestExclusionLift(
  env: Pick<Env, 'DB'>,
  userId: string,
  t: number,
): Promise<LimitsState> {
  const current = await loadLimits(env.DB, userId);
  if (!current || !permanentInForce(current, t)) {
    throw new HttpError('exclusion_not_permanent', 'Only a permanent self-exclusion can be lifted');
  }
  if (current.exclusion_lift_effective_at !== null) return limitsView(current, t);
  const allowedAt = addMonths(current.self_exclusion_started_at ?? t, EXCLUSION_LIFT_AFTER_MONTHS);
  if (t < allowedAt) {
    throw new HttpError(
      'exclusion_lift_too_early',
      `A permanent self-exclusion can be lifted from ${new Date(allowedAt).toISOString().slice(0, 10)}`,
    );
  }
  const next: LimitsRow = {
    ...current,
    exclusion_lift_requested_at: t,
    exclusion_lift_effective_at: t + EXCLUSION_LIFT_COOLING_OFF_MS,
  };
  await writeLimits(
    env.DB,
    userId,
    current,
    next,
    'exclusion_lift_requested',
    { liftEffectiveAt: next.exclusion_lift_effective_at },
    t,
  );
  return limitsView(next, t);
}
