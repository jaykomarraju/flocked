// Seeded D1 for tests. test/setup.ts has already applied migrations/ to this file's fresh D1;
// `seedFixture` adds a minimal, internally consistent data set:
//   * users: a player (500 global points from the signup grant), an admin and a second player;
//   * a house question (used) and the open daily round it belongs to, locked with the launch
//     defaults, with Free and Stakes `round_modes` rows (both pending);
//   * a room owned by the player, with its 500 room points from the join grant.
import { LOCKED_CONFIG_DEFAULTS, LockedConfigSchema, type LockedConfig } from '@flocked/shared';
import { QUICKNET_GENESIS, QUICKNET_PERIOD } from './constants.js';

export const FIXTURE_IDS = {
  user: '01K70000000000000000000001',
  admin: '01K70000000000000000000002',
  otherUser: '01K70000000000000000000003',
  question: '01K70000000000000000000010',
  round: '01K70000000000000000000020',
  room: '01K70000000000000000000030',
} as const;

/** The fixture round: opens 2026-10-07 21:00 and closes 2026-10-08 21:00 America/New_York (EDT). */
export const FIXTURE_ROUND = {
  opensAt: Date.UTC(2026, 9, 8, 1, 0, 0),
  closesAt: Date.UTC(2026, 9, 9, 1, 0, 0),
} as const;

/** First quicknet round whose time is at or after `tSec` (spec "Round lifecycle" › Scheduling). */
export function beaconRoundAtOrAfter(tSec: number): number {
  return Math.ceil((tSec - QUICKNET_GENESIS) / QUICKNET_PERIOD) + 1;
}

export const FIXTURE_CONFIG: LockedConfig = LockedConfigSchema.parse({
  beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
  free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
  stakes: {
    ...LOCKED_CONFIG_DEFAULTS.stakes,
    creator: '0x000000000000000000000000000000000000dead',
  },
});

/** A deterministic ULID for a fixture ledger row (G = global scope, R = room scope). */
function ledgerFixtureId(userId: string, scope: string): string {
  return `${userId.slice(0, 24)}${scope === 'global' ? 'G' : 'R'}${userId.slice(25)}`;
}

export interface Fixture {
  ids: typeof FIXTURE_IDS;
  round: { id: string; opensAt: number; closesAt: number; beaconRound: number; lockedAt: number };
  config: LockedConfig;
}

/** Inserts the fixture rows in one batch. Call once per test file (storage is per file). */
export async function seedFixture(db: D1Database): Promise<Fixture> {
  const ids = FIXTURE_IDS;
  const { opensAt, closesAt } = FIXTURE_ROUND;
  const createdAt = opensAt - 7 * 24 * 3600 * 1000;
  const lockedAt = opensAt - 6 * 3600 * 1000;
  const beaconRound = beaconRoundAtOrAfter(closesAt / 1000 + FIXTURE_CONFIG.beaconDelay);

  const user = (id: string, handle: string, role: 'user' | 'admin', ref: string) =>
    db
      .prepare(
        'INSERT INTO users (id, handle, display_name, role, ref_code, tos_version, tos_accepted_at, age_attested_at, created_at) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?6, ?6)',
      )
      .bind(id, handle, role, ref, '2026-10-01', createdAt);
  const grant = (userId: string, scope: string, reason: string, refId: string, n: number) => [
    db
      .prepare(
        'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, ?3, ?4)',
      )
      .bind(userId, scope, n, createdAt),
    db
      .prepare(
        'INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      )
      .bind(ledgerFixtureId(userId, scope), userId, scope, n, reason, refId, createdAt),
  ];

  await db.batch([
    user(ids.user, 'ewe_one', 'user', 'REFUSER1'),
    user(ids.admin, 'shepherd', 'admin', 'REFADMIN'),
    user(ids.otherUser, 'ewe_two', 'user', 'REFUSER2'),
    db
      .prepare(
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'wallet', ?3, ?4)",
      )
      .bind('01K70000000000000000000040', ids.user, `0x${'11'.repeat(20)}`, createdAt),
    ...grant(ids.user, 'global', 'signup', ids.user, 500),
    ...grant(ids.otherUser, 'global', 'signup', ids.otherUser, 500),
    db
      .prepare(
        "INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at) VALUES (?1, NULL, ?2, ?3, 'food', 'used', ?4)",
      )
      .bind(
        ids.question,
        'Pineapple on pizza?',
        JSON.stringify([
          { label: 'Yes', emoji: '🍍' },
          { label: 'No', emoji: '🚫' },
        ]),
        createdAt,
      ),
    db
      .prepare(
        "INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json) VALUES (?1, 'daily', NULL, ?2, ?3, ?4, ?5, 'open', ?6, ?7)",
      )
      .bind(
        ids.round,
        ids.question,
        opensAt,
        closesAt,
        beaconRound,
        lockedAt,
        JSON.stringify(FIXTURE_CONFIG),
      ),
    db
      .prepare(
        "INSERT INTO round_modes (round_id, mode, status, lock_tx) VALUES (?1, 'free', 'pending', ?2)",
      )
      .bind(ids.round, `0x${'aa'.repeat(32)}`),
    db
      .prepare(
        "INSERT INTO round_modes (round_id, mode, status, chain_round_id, lock_tx) VALUES (?1, 'stakes', 'pending', '1', ?2)",
      )
      .bind(ids.round, `0x${'bb'.repeat(32)}`),
    db
      .prepare(
        "INSERT INTO rooms (id, name, owner_user_id, invite_code, question_source, created_at) VALUES (?1, 'The Pen', ?2, 'PENINVITE', 'daily', ?3)",
      )
      .bind(ids.room, ids.user, createdAt),
    db
      .prepare(
        "INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)",
      )
      .bind(ids.room, ids.user, createdAt),
    ...grant(ids.user, ids.room, 'room_grant', ids.room, 500),
  ]);

  return {
    ids,
    round: { id: ids.round, opensAt, closesAt, beaconRound, lockedAt },
    config: FIXTURE_CONFIG,
  };
}

/** Current balance, or null without a balance row. */
export async function balanceOf(
  db: D1Database,
  userId: string,
  scope = 'global',
): Promise<number | null> {
  const row = await db
    .prepare('SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = ?2')
    .bind(userId, scope)
    .first<{ balance: number }>();
  return row?.balance ?? null;
}

/** Number of ledger rows for a user and scope. */
export async function ledgerCount(
  db: D1Database,
  userId: string,
  scope = 'global',
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ?1 AND scope = ?2')
    .bind(userId, scope)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
