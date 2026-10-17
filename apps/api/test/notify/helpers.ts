// Test doubles for the notify consumer: recording channels (the Channel interface the real senders
// implement) and seed helpers for entries, settlements, exclusions and prefs.
import type { Mode, NotificationChannel, NotifyMessage } from '@flocked/shared';
import type { NotifyDeps } from '../../src/notify/consumer.js';
import type { Channel, Delivery, Recipient } from '../../src/notify/types.js';

export const T = Date.UTC(2026, 9, 9, 1, 5, 0);

export interface FakeChannel<C extends NotificationChannel> extends Channel<C> {
  sent: Delivery<C>[];
  /** Dedupe keys this channel reports as transient failures, once each. */
  failOnce: Set<string>;
}

export function fakeChannel<C extends NotificationChannel>(
  name: C,
  available: (r: Recipient) => boolean = () => true,
): FakeChannel<C> {
  const ch: FakeChannel<C> = {
    name,
    sent: [],
    failOnce: new Set(),
    available,
    send(batch) {
      const retry: string[] = [];
      for (const d of batch) {
        if (ch.failOnce.delete(d.dedupeKey)) retry.push(d.dedupeKey);
        else ch.sent.push(d);
      }
      return Promise.resolve({ retry });
    },
  };
  return ch;
}

export function fakeDeps() {
  const farcaster = fakeChannel('farcaster');
  const webpush = fakeChannel('webpush');
  const email = fakeChannel('email', (r) => r.email !== null);
  const deps: NotifyDeps = {
    channels: { farcaster, webpush, email },
    origin: 'https://flocked.xyz',
    now: () => T,
  };
  return { deps, farcaster, webpush, email };
}

let seq = 0;
const id = (prefix: string) => `${prefix}${String(++seq).padStart(26 - prefix.length, '0')}`;

/** A valid, revealed entry. */
export async function seedEntry(
  db: D1Database,
  roundId: string,
  mode: Mode,
  userId: string,
  option: 0 | 1,
  opts: { stake?: number; valid?: 0 | 1 } = {},
): Promise<void> {
  const stakes = mode === 'stakes';
  await db
    .prepare(
      `INSERT INTO entries (id, round_id, mode, user_id, wallet, person_tag, stake, commitment, receipt_seq,
         tx_hash, block_number, log_index, option_index, valid, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
    .bind(
      id('01KE'),
      roundId,
      mode,
      userId,
      stakes ? '0x00000000000000000000000000000000000000aa' : null,
      stakes ? `tag-${userId}` : null,
      opts.stake ?? 100,
      `0x${seq.toString(16).padStart(64, '0')}`,
      stakes ? null : seq,
      stakes ? `0x${seq.toString(16).padStart(64, 'a')}` : null,
      stakes ? 1 : null,
      stakes ? seq : null,
      option,
      opts.valid ?? 1,
      T - 3_600_000,
    )
    .run();
}

/** The mode's current settlement record and status. */
export async function seedResult(
  db: D1Database,
  roundId: string,
  mode: Mode,
  r: {
    status: string;
    winner?: 0 | 1 | null;
    refundReason?: number | null;
    tally?: [number, number];
    seq?: number;
  },
): Promise<void> {
  const final = ['settled', 'refunded', 'voided'].includes(r.status);
  await db
    .prepare(
      `UPDATE round_modes SET status = ?3, refund_reason = ?4, revealed_at = ?5, final_at = ?6,
         claims_open_at = CASE WHEN mode = 'stakes' THEN ?7 ELSE NULL END
       WHERE round_id = ?1 AND mode = ?2`,
    )
    .bind(roundId, mode, r.status, r.refundReason ?? null, T, final ? T : null, T + 7_200_000)
    .run();
  const tally = r.tally ?? [3, 1];
  await db
    .prepare(
      `INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json, winners_json)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)`,
    )
    .bind(
      roundId,
      mode,
      r.seq ?? 0,
      r.winner === undefined || r.winner === null ? 'refunded' : 'settled',
      JSON.stringify([
        { headcount: tally[0], total: tally[0] * 100 },
        { headcount: tally[1], total: tally[1] * 100 },
      ]),
      JSON.stringify({ winner: r.winner ?? null, refundReason: r.refundReason ?? null }),
    )
    .run();
}

export async function exclude(db: D1Database, userId: string, until: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO limits (user_id, self_exclusion_started_at, self_exclusion_until) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id) DO UPDATE SET self_exclusion_until = excluded.self_exclusion_until`,
    )
    .bind(userId, T - 1000, until)
    .run();
}

export async function setPref(
  db: D1Database,
  userId: string,
  channel: NotificationChannel,
  event: string,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notification_prefs (user_id, channel, event, enabled) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (user_id, channel, event) DO UPDATE SET enabled = excluded.enabled`,
    )
    .bind(userId, channel, event, enabled ? 1 : 0)
    .run();
}

export async function verifyEmail(db: D1Database, userId: string, address: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'email', ?3, ?4)",
    )
    .bind(id('01KI'), userId, address, T - 1000)
    .run();
}

/** An `outcome` message as the producers build it. */
export function outcomeMessage(
  userId: string,
  roundId: string,
  mode: Mode,
  over: Partial<Extract<NotifyMessage, { event: 'outcome' }>['payload']> = {},
): NotifyMessage {
  return {
    event: 'outcome',
    userId,
    dedupeKey: `outcome:2026-10-08:${userId}`,
    payload: {
      roundId,
      gameDay: '2026-10-08',
      mode,
      result: 'win',
      amount: null,
      nextRoundId: null,
      refundReason: null,
      ...over,
    },
  };
}
