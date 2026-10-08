// The signed-in user's account view (`GET /me`, `PATCH /me`, `POST /me/tos`; spec "API").
// `users.prefs_json` keys are snake_case: show_card_amounts, show_stakes_net (both default off,
// spec "Share cards" and "Profiles"), creator_payout_wallet.
import {
  STAKES_INELIGIBILITY_REASONS,
  type Identity,
  type LimitsState,
  type Merge,
  type MeResponse,
  type NotificationPref,
  type StakesIneligibilityReason,
  type TosState,
  type UserPrefs,
} from '@flocked/shared';
import type { Env } from '../env.js';
import type { SessionUser } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { GLOBAL_SCOPE } from '../points/index.js';
import { tosVersion } from './config.js';

interface MeUserRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role: SessionUser['role'];
  status: SessionUser['status'];
  prefs_json: string;
  age_attested_at: number | null;
  tos_version: string | null;
  tos_accepted_at: number | null;
  kyc_status: string | null;
  person_id: string | null;
  person_verified_at: number | null;
  ref_code: string;
  coinbase_country: string | null;
  created_at: number;
}

interface StoredPrefs {
  show_card_amounts?: boolean;
  show_stakes_net?: boolean;
  creator_payout_wallet?: string | null;
}

interface LimitsRow {
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

interface MergeRow {
  id: string;
  status: Merge['status'];
  kept_user_id: string;
  losing_user_id: string;
  provider: Merge['provider'] | null;
  other_handle: string | null;
  created_at: number;
  expires_at: number;
  confirmed_at: number | null;
}

export function parsePrefs(json: string): StoredPrefs {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function prefsView(stored: StoredPrefs): UserPrefs {
  return {
    showCardAmounts: stored.show_card_amounts === true,
    showStakesNet: stored.show_stakes_net === true,
    creatorPayoutWallet: stored.creator_payout_wallet ?? null,
  };
}

/** Limits as stored, with `excluded` evaluated at `t` (spec "Compliance and responsible play"). */
export function limitsView(row: LimitsRow | null, t: number): LimitsState {
  const permanent = row?.self_exclusion_permanent === 1;
  const lifted =
    row?.exclusion_lift_effective_at !== null &&
    row?.exclusion_lift_effective_at !== undefined &&
    row.exclusion_lift_effective_at <= t;
  const timed = row?.self_exclusion_until != null && row.self_exclusion_until > t;
  return {
    dailyStakeCap: row?.daily_stake_cap != null ? String(row.daily_stake_cap) : null,
    pendingCap: row?.pending_cap != null ? String(row.pending_cap) : null,
    pendingCapEffectiveAt: row?.pending_cap_effective_at ?? null,
    selfExclusion: {
      startedAt: row?.self_exclusion_started_at ?? null,
      until: row?.self_exclusion_until ?? null,
      permanent,
      liftRequestedAt: row?.exclusion_lift_requested_at ?? null,
      liftEffectiveAt: row?.exclusion_lift_effective_at ?? null,
    },
    excluded: (permanent && !lifted) || timed,
    questionBlockUntil: row?.question_block_until ?? null,
  };
}

export function tosView(env: Pick<Env, 'TOS_VERSION'>, user: MeUserRow): TosState {
  return {
    currentVersion: tosVersion(env),
    acceptedVersion: user.tos_version,
    acceptedAt: user.tos_accepted_at,
    ageAttestedAt: user.age_attested_at,
  };
}

/**
 * Why Stakes is unavailable, in STAKES_INELIGIBILITY_REASONS order. Coinbase verification lands
 * in W5-B and the geo, kill-switch and cap checks in W5-B/W6-B, so until then every account is
 * at least `not_verified`.
 */
function stakesReasons(
  user: MeUserRow,
  tos: TosState,
  limits: LimitsState,
  personVerified: boolean,
): StakesIneligibilityReason[] {
  const reasons = new Set<StakesIneligibilityReason>();
  if (!personVerified) reasons.add('not_verified');
  if (user.age_attested_at === null) reasons.add('age_unattested');
  if (tos.acceptedVersion !== tos.currentVersion) reasons.add('tos_not_accepted');
  if (limits.excluded) reasons.add('self_excluded');
  if (user.status === 'suspended') reasons.add('suspended');
  return STAKES_INELIGIBILITY_REASONS.filter((r) => reasons.has(r));
}

/** Loads the user row the /me routes work from; 401 if it vanished under the session. */
export async function loadMeUser(db: D1Database, userId: string): Promise<MeUserRow> {
  const user = await db
    .prepare(
      'SELECT id, handle, display_name, avatar_url, role, status, prefs_json, age_attested_at, ' +
        'tos_version, tos_accepted_at, kyc_status, person_id, person_verified_at, ref_code, ' +
        'coinbase_country, created_at FROM users WHERE id = ?1',
    )
    .bind(userId)
    .first<MeUserRow>();
  if (!user) throw new HttpError('unauthorized', 'Sign in required');
  return user;
}

/** `GET /me`. */
export async function buildMe(env: Env, userId: string): Promise<MeResponse> {
  const db = env.DB;
  const t = now(env);
  const user = await loadMeUser(db, userId);
  const [identities, prefs, merges, balances, limits] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT id, provider, external_id, verified_at FROM identities WHERE user_id = ?1 ORDER BY id',
      )
      .bind(userId),
    db
      .prepare(
        'SELECT channel, event, enabled FROM notification_prefs WHERE user_id = ?1 ORDER BY channel, event',
      )
      .bind(userId),
    db
      .prepare(
        'SELECT m.id, m.status, m.kept_user_id, m.losing_user_id, m.created_at, m.expires_at, ' +
          'm.confirmed_at, i.provider, o.handle AS other_handle FROM merges m ' +
          'LEFT JOIN identities i ON i.id = m.identity_id ' +
          'LEFT JOIN users o ON o.id = CASE WHEN m.kept_user_id = ?1 THEN m.losing_user_id ELSE m.kept_user_id END ' +
          "WHERE (m.kept_user_id = ?1 OR m.losing_user_id = ?1) AND m.status = 'pending' AND m.expires_at > ?2 " +
          'ORDER BY m.created_at',
      )
      .bind(userId, t),
    db
      .prepare(
        'SELECT pb.scope, pb.balance FROM point_balances pb WHERE pb.user_id = ?1 AND (pb.scope = ?2 OR ' +
          'EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = pb.scope AND rm.user_id = pb.user_id)) ' +
          'ORDER BY pb.scope',
      )
      .bind(userId, GLOBAL_SCOPE),
    db.prepare('SELECT * FROM limits WHERE user_id = ?1').bind(userId),
  ]);

  const identityRows = (identities?.results ?? []) as {
    id: string;
    provider: Identity['provider'];
    external_id: string;
    verified_at: number | null;
  }[];
  const balanceRows = (balances?.results ?? []) as { scope: string; balance: number }[];
  const limitsState = limitsView((limits?.results[0] as LimitsRow | undefined) ?? null, t);
  const tos = tosView(env, user);
  const personVerified = user.person_id !== null && user.kyc_status === 'verified';
  const reasons = stakesReasons(user, tos, limitsState, personVerified);

  return {
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      role: user.role,
      status: user.status,
      refCode: user.ref_code,
      createdAt: user.created_at,
    },
    prefs: prefsView(parsePrefs(user.prefs_json)),
    notificationPrefs: (
      (prefs?.results ?? []) as { channel: string; event: string; enabled: number }[]
    ).map(
      (r) => ({ channel: r.channel, event: r.event, enabled: r.enabled === 1 }) as NotificationPref,
    ),
    identities: identityRows.map((r) => ({
      id: r.id,
      provider: r.provider,
      externalId: r.provider === 'coinbase' ? null : r.external_id,
      verifiedAt: r.verified_at,
    })),
    merges: ((merges?.results ?? []) as unknown as MergeRow[])
      .filter((m): m is MergeRow & { provider: Merge['provider'] } => m.provider !== null)
      .map((m) => ({
        id: m.id,
        status: m.status,
        keptUserId: m.kept_user_id,
        losingUserId: m.losing_user_id,
        provider: m.provider,
        otherHandle: m.other_handle,
        createdAt: m.created_at,
        expiresAt: m.expires_at,
        confirmedAt: m.confirmed_at,
      })),
    balances: {
      global: String(balanceRows.find((b) => b.scope === GLOBAL_SCOPE)?.balance ?? 0),
      rooms: balanceRows
        .filter((b) => b.scope !== GLOBAL_SCOPE)
        .map((b) => ({ roomId: b.scope, balance: String(b.balance) })),
    },
    limits: limitsState,
    flags: {
      /** No handle yet (new accounts): the client asks the user to pick one. */
      needsHandle: user.handle === null,
    },
    tos,
    verification: {
      personVerified,
      verifiedAt: personVerified ? user.person_verified_at : null,
      country: personVerified ? user.coinbase_country : null,
    },
    stakes: { eligible: reasons.length === 0, reasons },
  };
}
