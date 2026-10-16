// Seeds final (or pending) daily and room rounds straight into D1 for the stats, boards and
// referrals tests: users, the round and question, per-mode entries with their outcomes, the current
// settlement (tally and winner) and the payouts. Nothing here runs the settlement itself.
import { env } from 'cloudflare:test';
import { dailyClosesAt, dailyOpensAt, type Mode } from '@flocked/shared';

/** A deterministic ULID: `kind` is one Crockford letter, `n` the sequence number. */
export function ulid(kind: string, n: number): string {
  return `01K8${kind}${String(n).padStart(21, '0')}`;
}

export const userId = (n: number) => ulid('A', n);

export interface SeedUserOptions {
  handle?: string | null;
  verified?: boolean;
  status?: 'active' | 'suspended' | 'merged' | 'deleted';
  createdAt?: number;
  prefs?: Record<string, unknown>;
  displayName?: string | null;
}

/** Inserts user `n` (verified and active by default, created 30 days before Oct 1, 2026). */
export async function seedUser(n: number, o: SeedUserOptions = {}): Promise<string> {
  const id = userId(n);
  const verified = o.verified ?? true;
  const status = o.status ?? 'active';
  await env.DB.prepare(
    `INSERT INTO users (id, handle, display_name, status, merged_into, prefs_json, person_id,
       kyc_status, ref_code, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      o.handle === undefined ? `ewe_${n}` : o.handle,
      o.displayName ?? null,
      status,
      status === 'merged' ? userId(9999) : null,
      JSON.stringify(o.prefs ?? {}),
      verified ? `0xperson${String(n).padStart(4, '0')}` : null,
      verified ? 'verified' : null,
      `REF${String(n).padStart(5, '0')}`,
      o.createdAt ?? Date.UTC(2026, 8, 1),
    )
    .run();
  return id;
}

export type ModeOutcome = 'settled' | 'refunded' | 'voided' | 'pending' | 'revealing';

export interface SeedEntry {
  user: string;
  option: 0 | 1;
  /** 1 by default; 0 for a VOID entry. */
  valid?: 0 | 1;
  stake?: number;
  /** Credited amount (win / rebate / refund); defaults to 2 × stake for a winner, else 0. */
  payout?: number;
  createdAt?: number;
  foreign?: boolean;
}

export interface SeedMode {
  status: ModeOutcome;
  entries: SeedEntry[];
  /** The winning option of a settled mode; defaults to the side with fewer valid entries. */
  winner?: 0 | 1;
}

export interface SeedDay {
  /** Game day (YYYY-MM-DD); the round closes at 21:00 New York that day. */
  day: string;
  kind?: 'daily' | 'room';
  roomId?: string;
  category?: string;
  author?: string | null;
  questionStatus?: 'used' | 'queued' | 'scheduled';
  modes: Partial<Record<Mode, SeedMode>>;
}

let roundSeq = 0;
let entrySeq = 0;

const FINAL = new Set(['settled', 'refunded', 'voided']);

/** Seeds one round. Returns its ID and closesAt (epoch ms). */
export async function seedDay(d: SeedDay): Promise<{ roundId: string; closesAt: number }> {
  const db = env.DB;
  roundSeq += 1;
  const roundId = ulid('R', roundSeq);
  const questionId = ulid('Q', roundSeq);
  const kind = d.kind ?? 'daily';
  // Room rounds share a game day with the daily round: shift them so closes_at stays readable.
  const closesAt = dailyClosesAt(d.day) * 1000 - (kind === 'room' ? 3600_000 : 0);
  const opensAt = dailyOpensAt(d.day) * 1000;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        questionId,
        d.author ?? null,
        `Question ${roundSeq}?`,
        JSON.stringify([
          { label: 'Yes', emoji: '👍' },
          { label: 'No', emoji: '👎' },
        ]),
        d.category ?? 'food',
        d.questionStatus ?? 'used',
        opensAt - 10 * 86_400_000 + roundSeq,
      ),
    db
      .prepare(
        `INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round,
           status, locked_at, config_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'closed', ?8, '{}')`,
      )
      .bind(
        roundId,
        kind,
        kind === 'room' ? (d.roomId ?? ulid('M', 1)) : null,
        questionId,
        opensAt,
        closesAt,
        1000 + roundSeq,
        opensAt - 6 * 3600_000,
      ),
  ];
  for (const [mode, m] of Object.entries(d.modes) as [Mode, SeedMode][]) {
    const final = FINAL.has(m.status);
    const revealed = m.status === 'settled' || m.status === 'refunded';
    const valid = m.entries.filter((e) => (e.valid ?? 1) === 1);
    const n0 = valid.filter((e) => e.option === 0).length;
    const n1 = valid.length - n0;
    const winner = m.status === 'settled' ? (m.winner ?? (n0 < n1 ? 0 : 1)) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO round_modes (round_id, mode, status, revealed_at, final_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(
          roundId,
          mode,
          m.status,
          revealed ? closesAt + 90_000 : null,
          final ? closesAt + 90_000 : null,
        ),
    );
    if (revealed) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version,
               tally_json, winners_json, settled_at)
             VALUES (?1, ?2, 0, ?3, 1, ?4, ?5, ?6)`,
          )
          .bind(
            roundId,
            mode,
            m.status,
            JSON.stringify([
              { headcount: n0, total: '0' },
              { headcount: n1, total: '0' },
            ]),
            JSON.stringify({ winner }),
            closesAt + 90_000,
          ),
      );
    }
    m.entries.forEach((e, i) => {
      entrySeq += 1;
      const stake = e.stake ?? 100;
      const v = e.valid ?? 1;
      const payout =
        e.payout ?? (m.status === 'settled' && v === 1 && e.option === winner ? 2 * stake : 0);
      const wallet = `0x${String(entrySeq).padStart(40, '0')}`;
      stmts.push(
        db
          .prepare(
            `INSERT INTO entries (id, round_id, mode, user_id, foreign_entry, wallet, person_tag,
               stake, commitment, receipt_seq, tx_hash, block_number, log_index, option_index,
               valid, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
          )
          .bind(
            ulid('E', entrySeq),
            roundId,
            mode,
            e.foreign ? null : e.user, // a foreign entry has no user (entries_foreign)
            e.foreign ? 1 : 0,
            mode === 'stakes' ? wallet : null,
            mode === 'stakes' ? `0xtag${entrySeq}` : null,
            stake,
            `0x${String(entrySeq).padStart(64, '0')}`,
            mode === 'free' ? i : null,
            mode === 'stakes' ? `0x${String(entrySeq).padStart(64, 'f')}` : null,
            mode === 'stakes' ? entrySeq : null,
            mode === 'stakes' ? 0 : null,
            // Written even before the mode is final (the stats code only reads final modes), so
            // `finalizeMode` needs only the status and the settlement.
            e.option,
            v,
            e.createdAt ?? opensAt + 1000 * (i + 1),
          ),
      );
      if (payout > 0 && !e.foreign) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO payouts (round_id, mode, user_id, wallet, kind, amount)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            )
            .bind(
              roundId,
              mode,
              e.user,
              mode === 'stakes' ? wallet : null,
              m.status === 'settled' ? (e.option === winner ? 'win' : 'rebate') : 'refund',
              payout,
            ),
        );
      }
    });
  }
  await db.batch(stmts);
  return { roundId, closesAt };
}

/** Moves a seeded mode to a final status later (out-of-order finality). */
export async function finalizeMode(
  roundId: string,
  mode: Mode,
  status: 'settled' | 'refunded' | 'voided',
  winner: 0 | 1 | null = null,
): Promise<void> {
  const db = env.DB;
  const r = await db
    .prepare('SELECT closes_at FROM rounds WHERE id = ?1')
    .bind(roundId)
    .first<{ closes_at: number }>();
  const t = (r?.closes_at ?? 0) + 3 * 86_400_000;
  const revealed = status !== 'voided';
  const stmts = [
    db
      .prepare(
        'UPDATE round_modes SET status = ?3, revealed_at = ?4, final_at = ?5 WHERE round_id = ?1 AND mode = ?2',
      )
      .bind(roundId, mode, status, revealed ? t : null, t),
  ];
  if (revealed) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version,
             tally_json, winners_json, settled_at)
           VALUES (?1, ?2, 0, ?3, 1, '[{"headcount":1,"total":"0"},{"headcount":2,"total":"0"}]', ?4, ?5)`,
        )
        .bind(roundId, mode, status, JSON.stringify({ winner }), t),
    );
  }
  await db.batch(stmts);
}

export interface StatsRow {
  rounds_played: number;
  wins: number;
  losses: number;
  refunds: number;
  stray_streak: number;
  best_stray_streak: number;
  play_streak: number;
  net: number;
}

/** A user's `user_stats` row for `mode`, or null. */
export function statsOf(user: string, mode: Mode = 'free'): Promise<StatsRow | null> {
  return env.DB.prepare(
    `SELECT rounds_played, wins, losses, refunds, stray_streak, best_stray_streak, play_streak, net
     FROM user_stats WHERE user_id = ?1 AND mode = ?2`,
  )
    .bind(user, mode)
    .first<StatsRow>();
}

/** Every table this file seeds or the code writes, emptied (storage is per file, not per test). */
export async function resetTables(): Promise<void> {
  const tables = [
    'users',
    'identities',
    'questions',
    'rounds',
    'round_modes',
    'entries',
    'settlements',
    'payouts',
    'user_stats',
    'stats_days',
    'stats_wins',
    'stats_weeks',
    'referrals',
    'point_balances',
    'daily_grant_skips',
  ];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}
