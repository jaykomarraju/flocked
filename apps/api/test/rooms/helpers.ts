// Helpers for the room tests (W8-D): an env with fake moderation (the rubric model decides by a
// marker in the prompt, as test/questions does: `#reject` → a failed check, `#review` → a refusal,
// else pass; the duplicate index is a fake whose hit tests set) and a pinned clock, users, rooms and
// room rounds seeded in D1 (final ones with their settlement and decrypted entries), and requests
// through the full app as a fake session user.
import { env } from 'cloudflare:test';
import {
  API_BASE_PATH,
  ErrorEnvelopeSchema,
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  newUlid,
} from '@flocked/shared';
import { keccak256, toHex } from 'viem';
import { vi } from 'vitest';
import { app } from '../../src/app.js';
import { withAuthDeps, type AuthDeps } from '../../src/auth/deps.js';
import type { Env } from '../../src/env.js';
import type { SessionUser } from '../../src/lib/auth-context.js';
import { withModerationDeps } from '../../src/moderation/deps.js';
import type { DuplicateIndex, ModerationModel } from '../../src/moderation/index.js';
import { fakeUser, withSession } from '../helpers/index.js';
import { verdictFor } from '../questions/routes-helpers.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * 2026-10-15 12:00 New York (EDT), a Thursday: mid game day 2026-10-15 (2026-10-14 21:00 to
 * 2026-10-15 21:00). The next slot (game day 2026-10-16) opens at 21:00 and locks at 15:00.
 */
export const T0 = Date.UTC(2026, 9, 15, 16, 0, 0);
/** Game day 2026-10-15's daily window (epoch ms). */
export const TODAY = {
  opensAt: Date.UTC(2026, 9, 15, 1, 0, 0),
  closesAt: Date.UTC(2026, 9, 16, 1),
};
/** The next slot's window (game day 2026-10-16) and its question lock (15:00 New York). */
export const NEXT = {
  opensAt: Date.UTC(2026, 9, 16, 1, 0, 0),
  closesAt: Date.UTC(2026, 9, 17, 1, 0, 0),
  lockAt: Date.UTC(2026, 9, 15, 19, 0, 0),
};

export const model = {
  classify: vi.fn<ModerationModel['classify']>((q) => Promise.resolve(verdictFor(q))),
};
export const duplicates = {
  findDuplicate: vi.fn<DuplicateIndex['findDuplicate']>(() => Promise.resolve(null)),
  add: vi.fn<DuplicateIndex['add']>(() => Promise.resolve()),
};

/** Resets the moderation fakes to their defaults. */
export function resetModeration(): void {
  model.classify.mockReset();
  model.classify.mockImplementation((q) => Promise.resolve(verdictFor(q)));
  duplicates.findDuplicate.mockReset();
  duplicates.findDuplicate.mockImplementation(() => Promise.resolve(null));
  duplicates.add.mockReset();
  duplicates.add.mockImplementation(() => Promise.resolve());
}

/**
 * The env the routes run with, the clock pinned to `t`. `fakeDuplicates: false` keeps the real
 * duplicate index (the local D1 stand-in, since ENVIRONMENT is 'local'); `turnstileFetch` fakes
 * siteverify (POST /questions needs it).
 */
export function roomsEnv(
  t = T0,
  opts: { fakeDuplicates?: boolean; turnstileFetch?: AuthDeps['turnstileFetch'] } = {},
): Env {
  let e: Env = { ...env, ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(t) };
  // withAuthDeps copies the env; the moderation fakes register on the copy, so they go last.
  if (opts.turnstileFetch) e = withAuthDeps(e, { turnstileFetch: opts.turnstileFetch });
  return withModerationDeps(e, opts.fakeDuplicates === false ? { model } : { model, duplicates });
}

/** Pins the clock of `e` to `ms`. */
export function setClock(e: Env, ms: number): void {
  Object.assign(e, { ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(ms) });
}

export interface TestUser {
  id: string;
  handle: string;
  user: SessionUser;
}

let users = 0;

/** Inserts a user (active unless `status` says otherwise), created 30 days before T0. */
export async function createUser(
  opts: { status?: 'active' | 'suspended' | 'deleted'; createdAt?: number } = {},
): Promise<TestUser> {
  users += 1;
  const id = newUlid((opts.createdAt ?? T0 - 30 * DAY) + users);
  const handle = `rm_${users}_${id.slice(-6).toLowerCase()}`;
  const deleted = opts.status === 'deleted';
  await env.DB.prepare(
    "INSERT INTO users (id, handle, display_name, role, status, ref_code, created_at) VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6)",
  )
    .bind(
      id,
      deleted ? null : handle,
      deleted ? null : `Name ${handle}`,
      opts.status ?? 'active',
      `RM${id.slice(-12)}`,
      opts.createdAt ?? T0 - 30 * DAY,
    )
    .run();
  const status = opts.status === 'suspended' ? 'suspended' : 'active';
  return { id, handle, user: fakeUser({ id, status }) };
}

/** The public user a member is served as. */
export const publicUser = (u: TestUser) => ({
  id: u.id,
  handle: u.handle,
  displayName: `Name ${u.handle}`,
  avatarUrl: null,
});

export interface MemberSeed {
  user: { id: string };
  joinedAt: number;
  /** Room balance; no balance row when undefined. */
  balance?: number;
}

/** Inserts a room with its owner (first member) and members; returns its ID. */
export async function seedRoom(opts: {
  owner: MemberSeed;
  members?: MemberSeed[];
  source?: 'daily' | 'custom';
  closedAt?: number;
}): Promise<{ id: string; inviteCode: string }> {
  const id = newUlid(opts.owner.joinedAt);
  const inviteCode = `INV${id.slice(-12)}`;
  const db = env.DB;
  const member = (m: MemberSeed, role: 'owner' | 'member') => [
    db
      .prepare(
        'INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, ?4)',
      )
      .bind(id, m.user.id, role, m.joinedAt),
    ...(m.balance === undefined
      ? []
      : [
          db
            .prepare(
              'INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (?1, ?2, ?3, ?4)',
            )
            .bind(m.user.id, id, m.balance, m.joinedAt),
        ]),
  ];
  await db.batch([
    db
      .prepare(
        'INSERT INTO rooms (id, name, owner_user_id, invite_code, question_source, created_at, closed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      )
      .bind(
        id,
        'Test room',
        opts.owner.user.id,
        inviteCode,
        opts.source ?? 'custom',
        opts.owner.joinedAt,
        opts.closedAt ?? null,
      ),
    ...member(opts.owner, 'owner'),
    ...(opts.members ?? []).flatMap((m) => member(m, 'member')),
  ]);
  return { id, inviteCode };
}

const ROOM_CONFIG = JSON.stringify(
  LockedConfigSchema.parse({
    beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
    free: { ...LOCKED_CONFIG_DEFAULTS.free, minEntrants: 3, awardRecipient: null },
  }),
);

/** A house question for seeded rounds; returns its ID. */
export async function insertQuestion(prompt = 'Cats or dogs?', createdAt = T0 - 10 * DAY) {
  const id = newUlid(createdAt);
  await env.DB.prepare(
    "INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at) VALUES (?1, NULL, ?2, ?3, 'other', 'used', ?4)",
  )
    .bind(
      id,
      prompt,
      JSON.stringify([
        { label: 'Cats', emoji: '🐈' },
        { label: 'Dogs', emoji: '🐕' },
      ]),
      createdAt,
    )
    .run();
  return id;
}

export interface EntrySeed {
  user: { id: string };
  /** The decrypted option, or 'void' for an invalid entry; undefined while not decrypted. */
  pick?: 0 | 1 | 'void';
}

export interface RoomRoundSeed {
  roomId: string;
  opensAt: number;
  /** Default: 24 h after opensAt. */
  closesAt?: number;
  /** Default: locked (6 h before opensAt), with a question and a config. */
  locked?: boolean;
  status?: 'scheduled' | 'open' | 'closed';
  /** The Free mode (locked rounds only): its status, reveal time and winner. */
  free?: {
    status: 'pending' | 'revealing' | 'settled' | 'refunded' | 'voided';
    revealedAt?: number | null;
    /** The winning option of a settled mode. */
    winner?: 0 | 1;
  };
  entries?: EntrySeed[];
}

/** Inserts a room round (and its Free mode, settlement and entries); returns its ID. */
export async function seedRoomRound(r: RoomRoundSeed): Promise<string> {
  const id = newUlid(r.opensAt);
  const closesAt = r.closesAt ?? r.opensAt + DAY;
  const locked = r.locked ?? true;
  const db = env.DB;
  const questionId = locked ? await insertQuestion() : null;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        'INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json) ' +
          "VALUES (?1, 'room', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      )
      .bind(
        id,
        r.roomId,
        questionId,
        r.opensAt,
        closesAt,
        locked ? 1 : null,
        r.status ?? (locked ? 'closed' : 'scheduled'),
        locked ? r.opensAt - 6 * HOUR : null,
        locked ? ROOM_CONFIG : null,
      ),
  ];
  const free = r.free ?? (locked ? { status: 'pending' as const } : undefined);
  if (free) {
    const final = ['settled', 'refunded', 'voided'].includes(free.status);
    const revealedAt =
      free.revealedAt !== undefined
        ? free.revealedAt
        : free.status === 'settled' || free.status === 'refunded'
          ? closesAt + 5 * MINUTE
          : null;
    statements.push(
      db
        .prepare(
          "INSERT INTO round_modes (round_id, mode, status, revealed_at, final_at) VALUES (?1, 'free', ?2, ?3, ?4)",
        )
        .bind(id, free.status, revealedAt, final ? closesAt + 5 * MINUTE : null),
    );
    if (free.status === 'settled' || free.status === 'refunded') {
      const entries = r.entries ?? [];
      const count = (o: 0 | 1) => entries.filter((e) => e.pick === o).length;
      statements.push(
        db
          .prepare(
            'INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json, winners_json, settled_at) ' +
              "VALUES (?1, 'free', 0, ?2, 1, ?3, ?4, ?5)",
          )
          .bind(
            id,
            free.status,
            JSON.stringify([
              { headcount: count(0), total: String(10 * count(0)) },
              { headcount: count(1), total: String(10 * count(1)) },
            ]),
            free.status === 'settled' ? JSON.stringify({ winner: free.winner ?? 0 }) : null,
            closesAt + 5 * MINUTE,
          ),
      );
    }
  }
  (r.entries ?? []).forEach((e, seq) => {
    const decrypted = e.pick !== undefined;
    statements.push(
      db
        .prepare(
          'INSERT INTO entries (id, round_id, mode, user_id, stake, commitment, receipt_seq, option_index, valid, void_reason, created_at) ' +
            "VALUES (?1, ?2, 'free', ?3, 10, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .bind(
          newUlid(r.opensAt + MINUTE),
          id,
          e.user.id,
          keccak256(toHex(`${id}:${seq}`)),
          seq,
          decrypted && e.pick !== 'void' ? e.pick : null,
          decrypted ? (e.pick === 'void' ? 0 : 1) : null,
          e.pick === 'void' ? 'bad_option' : null,
          r.opensAt + MINUTE,
        ),
    );
  });
  await db.batch(statements);
  return id;
}

const url = (path: string) => `https://flocked.test${API_BASE_PATH}${path}`;

/** A request through the full app, as `as` (anonymous when undefined). */
export function call(
  e: Env,
  as: SessionUser | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const client = as ? withSession(app, as) : app;
  return Promise.resolve(client.request(url(path), init, e));
}

/** The error code of an error response. */
export async function errorCode(res: Response): Promise<string> {
  return ErrorEnvelopeSchema.parse(await res.json()).error.code;
}

export const QUESTION_BODY = {
  prompt: 'Window seat or aisle seat?',
  options: [{ label: 'Window', emoji: '🪟' }, { label: 'Aisle' }],
  category: 'life',
};

/** A room's balance for a user, or null without a row. */
export async function roomBalance(userId: string, roomId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT balance FROM point_balances WHERE user_id = ?1 AND scope = ?2',
  )
    .bind(userId, roomId)
    .first<{ balance: number }>();
  return row?.balance ?? null;
}

/** The user's ledger rows in a room's scope. */
export async function roomLedger(userId: string, roomId: string) {
  const { results } = await env.DB.prepare(
    'SELECT delta, reason, ref_id FROM points_ledger WHERE user_id = ?1 AND scope = ?2 ORDER BY created_at, id',
  )
    .bind(userId, roomId)
    .all<{ delta: number; reason: string; ref_id: string }>();
  return results;
}

/** The room's rounds, by close. */
export async function roomRounds(roomId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, question_id, opens_at, closes_at, status, locked_at FROM rounds WHERE kind = 'room' AND room_id = ?1 ORDER BY closes_at",
  )
    .bind(roomId)
    .all<{
      id: string;
      question_id: string | null;
      opens_at: number;
      closes_at: number;
      status: string;
      locked_at: number | null;
    }>();
  return results;
}
