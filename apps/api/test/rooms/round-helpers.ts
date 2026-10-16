// Room round test helpers (W8-D): rooms, members with room balances, accounts of a chosen age, room
// questions, unlocked room rounds for the scheduler tests, and locked, closed Free room rounds seeded
// like test/settlement's `seedFreeRound` (real tlock picks for the recorded beacon, the commitment
// anchored and mirrored) so the real settlement pipeline can run them. D1 and R2 are per test file.
import { env } from 'cloudflare:test';
import { freeCommitmentTree } from '@flocked/settle';
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  MODE_CODES,
  ROOM_MIN_QUALIFYING_ENTRANTS,
  newUlid,
  roundKey,
  ulidToBytes,
  type LockedConfig,
} from '@flocked/shared';
import { bytesToHex, keccak256, type Hex } from 'viem';
import { receiptUserIdHash } from '../../src/crypto/receipt.js';
import type { DailySlot } from '../../src/scheduler/create.js';
import type { BundleChunk } from '../../src/settlement/types.js';
import {
  BEACON,
  BEACON_TIME_MS,
  pick,
  tamperedPick,
  type SeededRound,
} from '../settlement/helpers.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

const randomHex = (bytes: number): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

let users = 0;

/**
 * An active user created at `createdAt` (epoch ms; default long ago). `verified` gives it a person ID
 * and `kyc_status` verified, which the boards require to list it.
 */
export async function insertUser(o: { createdAt?: number; verified?: boolean } = {}) {
  const id = newUlid();
  users += 1;
  await env.DB.prepare(
    `INSERT INTO users (id, handle, ref_code, status, person_id, kyc_status, person_verified_at, created_at)
     VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      `room_${users}_${id.slice(-6).toLowerCase()}`,
      `RM${id.slice(-12)}`,
      o.verified ? `person-${id}` : null,
      o.verified ? 'verified' : null,
      o.verified ? 0 : null,
      o.createdAt ?? 0,
    )
    .run();
  return id;
}

/** A room (mirror unless `custom`), owned by a new user unless `owner` is given. */
export async function insertRoom(
  o: { source?: 'daily' | 'custom'; closedAt?: number | null; owner?: string } = {},
): Promise<{ roomId: string; owner: string }> {
  const roomId = newUlid();
  const owner = o.owner ?? (await insertUser());
  await env.DB.prepare(
    `INSERT INTO rooms (id, name, owner_user_id, invite_code, question_source, created_at, closed_at)
     VALUES (?1, 'Flock', ?2, ?3, ?4, 0, ?5)`,
  )
    .bind(roomId, owner, `inv${roomId.slice(-10)}`, o.source ?? 'daily', o.closedAt ?? null)
    .run();
  return { roomId, owner };
}

/** Makes `userId` a member of `roomId` with `balance` room points (a seeded `admin` ledger row). */
export async function addMember(roomId: string, userId: string, balance = 500): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', 0) ON CONFLICT DO NOTHING",
    ).bind(roomId, userId),
    env.DB.prepare(
      'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, ?3, 0)',
    ).bind(userId, roomId, balance),
    env.DB.prepare(
      "INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) VALUES (?1, ?2, ?3, ?4, 'admin', ?5, 0)",
    ).bind(newUlid(), userId, roomId, balance, `seed-${roomId}`),
  ]);
}

/** A room's custom question (moderated: `scheduled`), as POST /rooms/:id/questions stores it. */
export async function insertRoomQuestion(
  roomId: string,
  o: { author?: string | null; status?: string } = {},
): Promise<string> {
  const id = newUlid();
  const rejected = o.status === 'rejected';
  await env.DB.prepare(
    `INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at, room_id,
       rejected_at, rejection_reason)
     VALUES (?1, ?2, ?3, ?4, 'other', ?5, 0, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      o.author ?? null,
      `Flock question ${id}?`,
      JSON.stringify([
        { label: 'Left', emoji: '👈' },
        { label: 'Right', emoji: '👉' },
      ]),
      o.status ?? 'scheduled',
      roomId,
      rejected ? 0 : null,
      rejected ? 'Rejected' : null,
    )
    .run();
  return id;
}

/** A public question (used) for a daily round. */
async function insertDailyQuestion(author: string | null): Promise<string> {
  const id = newUlid();
  await env.DB.prepare(
    `INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'other', 'used', 0)`,
  )
    .bind(
      id,
      author,
      `Daily question ${id}?`,
      JSON.stringify([
        { label: 'Up', emoji: '👆' },
        { label: 'Down', emoji: '👇' },
      ]),
    )
    .run();
  return id;
}

/** Sets the account's creation time (epoch ms). */
export async function setCreatedAt(userId: string, createdAt: number): Promise<void> {
  await env.DB.prepare('UPDATE users SET created_at = ?2 WHERE id = ?1')
    .bind(userId, createdAt)
    .run();
}

/** An unlocked room round for `slot` (as `insertRoomRound` makes it), with an optional draft. */
export async function insertRoomRoundRow(
  roomId: string,
  slot: DailySlot,
  o: { id?: string; questionId?: string | null; draft?: object | null } = {},
): Promise<string> {
  const id = o.id ?? newUlid();
  await env.DB.prepare(
    `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, status, config_json)
     VALUES (?1, 'room', ?2, ?3, ?4, ?5, 'scheduled', ?6)`,
  )
    .bind(
      id,
      roomId,
      o.questionId ?? null,
      slot.opensAt,
      slot.closesAt,
      o.draft ? JSON.stringify(o.draft) : null,
    )
    .run();
  return id;
}

/** Sets `rooms.stakes.enabled` and `mode.stakes.enabled` (JSON true when on; no row when off). */
export async function setStakesFlags(o: { rooms: boolean; stakes: boolean }): Promise<void> {
  for (const [key, on] of [
    ['rooms.stakes.enabled', o.rooms],
    ['mode.stakes.enabled', o.stakes],
  ] as const) {
    await (
      on
        ? env.DB.prepare(
            "INSERT INTO config (key, value_json, updated_at) VALUES (?1, 'true', 0) ON CONFLICT (key) DO UPDATE SET value_json = 'true'",
          ).bind(key)
        : env.DB.prepare('DELETE FROM config WHERE key = ?1').bind(key)
    ).run();
  }
}

// Seeded room rounds for settlement ------------------------------------------------------------

/** The Free config a room round locks with (W8-D): minEntrants 3, no creator award. */
export function roomFreeConfig(free: Partial<LockedConfig['free']> = {}): LockedConfig {
  return LockedConfigSchema.parse({
    beaconDelay: 120,
    free: {
      ...LOCKED_CONFIG_DEFAULTS.free,
      minEntrants: ROOM_MIN_QUALIFYING_ENTRANTS,
      awardRecipient: null,
      ...free,
    },
  });
}

export interface RoomEntrant {
  userId: string;
  /** A valid pick, or a VOID (a plaintext whose option index is 2: `bad_option`). */
  pick: 0 | 1 | 'void';
  stake?: number;
}

export interface SeededRoomRound extends SeededRound {
  closesAt: number;
  questionId: string;
}

let seeded = 0;

/**
 * A locked, closed Free room round of `roomId` targeting BEACON.round, mode pending, with one entry
 * per entrant in seq order and the commitment anchored and mirrored (`Committed`), ready for the real
 * SettlementDO. Its question is a custom room question by `author`. Each seeded round closes a minute
 * before the previous one (close times stay unique), hours before the beacon.
 */
export function seedRoomFree(
  roomId: string,
  entrants: readonly RoomEntrant[],
  o: { author?: string | null; free?: Partial<LockedConfig['free']> } = {},
): Promise<SeededRoomRound> {
  return seedFree(roomId, entrants, { ...o, config: roomFreeConfig(o.free) });
}

/** The same as a daily round (the launch Free defaults, award to `author`), for comparison. */
export function seedDailyFree(
  entrants: readonly RoomEntrant[],
  o: { author?: string | null } = {},
): Promise<SeededRoomRound> {
  const config = LockedConfigSchema.parse({
    beaconDelay: 120,
    free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: o.author ?? null },
  });
  return seedFree(null, entrants, { ...o, config });
}

async function seedFree(
  roomId: string | null,
  entrants: readonly RoomEntrant[],
  o: { author?: string | null; config: LockedConfig },
): Promise<SeededRoomRound> {
  const roundId = newUlid();
  seeded += 1;
  const closesAt = BEACON_TIME_MS - 6 * HOUR - seeded * MIN;
  const opensAt = closesAt - DAY;
  const config = o.config;
  const questionId = roomId
    ? await insertRoomQuestion(roomId, { author: o.author ?? null, status: 'used' })
    : await insertDailyQuestion(o.author ?? null);
  const rows = await Promise.all(
    entrants.map(async (e, seq) => {
      const ct =
        e.pick === 'void' ? await tamperedPick(roundId, 17, 2) : await pick(roundId, e.pick);
      return {
        id: newUlid(),
        userId: e.userId,
        userIdHash: receiptUserIdHash(roundId, e.userId),
        stake: e.stake ?? 10,
        commitment: keccak256(ct),
        ct,
        seq,
      };
    }),
  );
  const root = freeCommitmentTree(
    rows.map((r) => ({
      roundId: ulidToBytes(roundId),
      mode: MODE_CODES.free,
      userIdHash: r.userIdHash,
      stake: BigInt(r.stake),
      commitment: r.commitment,
      seq: r.seq,
    })),
  ).root;
  const commitTx = randomHex(32);
  const db = env.DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json)
         VALUES (?1, ?9, ?2, ?3, ?4, ?5, ?6, 'closed', ?7, ?8)`,
      )
      .bind(
        roundId,
        roomId,
        questionId,
        opensAt,
        closesAt,
        BEACON.round,
        opensAt - 6 * HOUR,
        JSON.stringify(config),
        roomId ? 'room' : 'daily',
      ),
    db
      .prepare(
        "INSERT INTO round_modes (round_id, mode, status, commitment_root, commit_tx) VALUES (?1, 'free', 'pending', ?2, ?3)",
      )
      .bind(roundId, root, commitTx),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO entries (id, round_id, mode, user_id, stake, ciphertext, commitment, receipt_seq, created_at)
           VALUES (?1, ?2, 'free', ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(r.id, roundId, r.userId, r.stake, r.ct, r.commitment, r.seq, closesAt - MIN),
    ),
    db
      .prepare(
        `INSERT INTO chain_events (chain_id, contract, block_number, block_hash, block_timestamp, tx_hash,
           log_index, event, args_json, created_at, updated_at)
         VALUES (31337, ?1, 1, ?2, ?3, ?4, 0, 'Committed', ?5, 0, 0)`,
      )
      .bind(
        `0x${'aa'.repeat(20)}`,
        randomHex(32),
        Math.floor(closesAt / 1000) + 10,
        commitTx,
        JSON.stringify({
          roundKey: roundKey(roundId, 'free'),
          commitmentRoot: root,
          entryCount: String(rows.length),
          totalStake: String(rows.reduce((s, r) => s + r.stake, 0)),
        }),
      ),
  ]);
  return {
    roundId,
    config,
    closesAt,
    questionId,
    entries: rows.map(({ id, userId, userIdHash, stake, commitment }) => ({
      id,
      userId,
      userIdHash,
      stake,
      commitment,
    })),
    root,
    commitTx,
  };
}

/** A bundle chunk of the round's Free mode, parsed. */
export async function bundleChunk(roundId: string, index = 0): Promise<BundleChunk> {
  const key = `bundles/${roundId}/free/chunk-${String(index).padStart(4, '0')}.json`;
  const obj = await env.BUCKET.get(key);
  if (!obj) throw new Error(`no bundle chunk ${key}`);
  return obj.json<BundleChunk>();
}

/** The Free mode's status and refund reason. */
export async function freeMode(roundId: string) {
  return env.DB.prepare(
    "SELECT status, refund_reason FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
  )
    .bind(roundId)
    .first<{ status: string; refund_reason: number | null }>();
}

/** A user's ledger rows for one reference, in one scope. */
export async function ledgerFor(userId: string, scope: string, refId: string) {
  const { results } = await env.DB.prepare(
    'SELECT reason, delta FROM points_ledger WHERE user_id = ?1 AND scope = ?2 AND ref_id = ?3 ORDER BY reason',
  )
    .bind(userId, scope, refId)
    .all<{ reason: string; delta: number }>();
  return results;
}

/** A balance (null when the user has no row in the scope). */
export async function balanceOf(userId: string, scope: string): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = ?2',
  )
    .bind(userId, scope)
    .first<{ balance: number }>();
  return row?.balance ?? null;
}
