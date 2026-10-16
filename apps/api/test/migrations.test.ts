// migrations/0001_init.sql against the spec's "Data model". The expected schema below is transcribed
// from the spec table (not from the SQL), so a missing column or key fails here.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedFixture } from './helpers/index.js';

/** Every D1 table and its spec columns ("Data model", Key columns). analytics_events is not in D1. */
const SPEC_COLUMNS: Record<string, readonly string[]> = {
  users: [
    'id',
    'handle',
    'display_name',
    'avatar_url',
    'role',
    'status',
    'merged_into',
    'prefs_json',
    'age_attested_at',
    'tos_version',
    'tos_accepted_at',
    'kyc_status',
    'person_id',
    'person_verified_at',
    'ref_code',
    'coinbase_country',
    'coinbase_region',
    'created_at',
    // 0012 (W6-B): the age the latest attestation named (spec issue raised in docs/sessions/W6-B.md).
    'age_attested_min',
  ],
  identities: ['id', 'user_id', 'provider', 'external_id', 'verified_at', 'data_json'],
  questions: [
    'id',
    'author_user_id',
    'prompt',
    'options_json',
    'category',
    'status',
    'moderation_json',
    'score',
    'created_at',
    // 0017 (W8-A): admin review, and the rejection the author sees (not yet in the spec's data model).
    'needs_review',
    'rejection_reason',
    'rejected_at',
  ],
  // 0017 (W8-A): each vote's decay weight, fixed when it is cast.
  question_votes: ['question_id', 'user_id', 'value', 'created_at', 'weight'],
  rounds: [
    'id',
    'kind',
    'room_id',
    'question_id',
    'opens_at',
    'closes_at',
    'beacon_round',
    'status',
    'locked_at',
    'config_json',
  ],
  round_modes: [
    'round_id',
    'mode',
    'status',
    'refund_reason',
    'chain_round_id',
    'lock_tx',
    'commitment_root',
    'commit_tx',
    'bundle_hash',
    'revealed_at',
    'claims_open_at',
    'final_at',
  ],
  stakes_tickets: [
    'ticket_hash',
    'round_id',
    'person_tag',
    'user_id',
    'wallet',
    'expiry',
    'issued_at',
    'used_tx',
    // 0012 (W6-B): the round's game day, for the one-live-ticket-per-game-day insert.
    'game_day',
  ],
  entries: [
    'id',
    'round_id',
    'mode',
    'user_id',
    'foreign_entry',
    'wallet',
    'person_tag',
    'stake',
    'ciphertext',
    'commitment',
    'receipt_seq',
    'tx_hash',
    'block_number',
    'log_index',
    'option_index',
    'valid',
    'void_reason',
    'created_at',
  ],
  settlements: [
    'round_id',
    'mode',
    'proposal_seq',
    'outcome',
    'formula_version',
    'tally_json',
    'winners_json',
    'loss_pool',
    'fee',
    'creator_fee',
    'distributable',
    'rebate_pool',
    'dust',
    'payout_root',
    'manifest_r2_key',
    'bundle_hash',
    'settled_at',
    'tx_hash',
    'superseded_at',
  ],
  payouts: ['round_id', 'mode', 'user_id', 'wallet', 'kind', 'amount', 'claimed_at', 'claim_tx'],
  point_balances: ['user_id', 'scope', 'balance', 'updated_at'],
  points_ledger: ['id', 'user_id', 'scope', 'delta', 'reason', 'ref_id', 'created_at'],
  user_stats: [
    'user_id',
    'mode',
    'rounds_played',
    'wins',
    'losses',
    'refunds',
    'stray_streak',
    'best_stray_streak',
    'play_streak',
    'net',
    'updated_at',
  ],
  rooms: ['id', 'name', 'owner_user_id', 'invite_code', 'question_source', 'created_at'],
  room_members: ['room_id', 'user_id', 'role', 'joined_at'],
  share_cards: ['share_id', 'round_id', 'mode', 'user_id', 'kind', 'r2_prefix', 'created_at'],
  merges: [
    'id',
    'kept_user_id',
    'losing_user_id',
    'identity_id',
    'status',
    'expires_at',
    'created_at',
    'confirmed_at',
  ],
  referrals: [
    'referrer_user_id',
    'referee_user_id',
    'status',
    'qualified_round_id',
    'rewarded_at',
    'created_at',
    // 0018 (W8-B): the cap's week and the reward attempt rotation (W8-B spec issue).
    'reward_week',
    'checked_at',
  ],
  sessions: ['id_hash', 'user_id', 'expires_at', 'created_at', 'user_agent'],
  notification_prefs: ['user_id', 'channel', 'event', 'enabled'],
  push_subscriptions: ['id', 'user_id', 'endpoint', 'keys_json'],
  limits: [
    'user_id',
    'daily_stake_cap',
    'pending_cap',
    'pending_cap_effective_at',
    'self_exclusion_started_at',
    'self_exclusion_until',
    'self_exclusion_permanent',
    'exclusion_lift_requested_at',
    'exclusion_lift_effective_at',
    'question_block_until',
  ],
  indexer_state: [
    'chain_id',
    'contract',
    'last_block_number',
    'last_block_hash',
    // 0020 (W7-F1 R18, owner decision C4): the position's block timestamp, Unix seconds.
    'last_block_timestamp',
    'updated_at',
  ],
  // 0006_indexer (W4-B): the wave-4 pinned chain_events and sent_txs, plus dispatch bookkeeping and
  // settlement holds; not yet rows in the spec's data model.
  chain_events: [
    'chain_id',
    'contract',
    'block_number',
    'block_hash',
    'block_timestamp',
    'tx_hash',
    'log_index',
    'event',
    'args_json',
    'removed',
    'revision',
    'dispatched_revision',
    'dispatch_attempts',
    'dispatch_error',
    'created_at',
    'updated_at',
    'dispatch_alerted_at', // 0007 (W4-F1): ALERT_DO_ERROR repeats while a row keeps failing
  ],
  // 0007_review_fixes (W4-F1): poll-end checkpoints for reorg repair, and the removals queue.
  indexer_checkpoints: ['chain_id', 'contract', 'block_number', 'block_hash', 'created_at'],
  chain_event_removals: [
    'chain_id',
    'tx_hash',
    'log_index',
    'revision',
    'contract',
    'block_number',
    'block_hash',
    'block_timestamp',
    'event',
    'args_json',
    'dispatched',
    'dispatch_attempts',
    'dispatch_error',
    'dispatch_alerted_at',
    'created_at',
  ],
  chain_event_handled: ['chain_id', 'tx_hash', 'log_index', 'revision', 'handler', 'handled_at'],
  sent_txs: ['chain_id', 'tx_hash', 'round_key', 'kind', 'created_at'],
  settlement_holds: [
    'round_id',
    'mode',
    'reason',
    'tx_hash',
    'created_at',
    'released_at',
    'released_by',
  ],
  anchors: ['id', 'kind', 'round_keys_json', 'tx_hash', 'block_timestamp', 'created_at'],
  audit_log: ['id', 'actor', 'actor_user_id', 'action', 'target', 'data_json', 'created_at'],
  // 0003_round_do (W3-B): the final skip of a daily grant; not yet a row in the spec's data model.
  daily_grant_skips: ['user_id', 'round_id', 'balance', 'skipped_at'],
  // 0018_stats (W8-B): the days user_stats has absorbed, the Strays board's winners and the Weekly
  // board's weeks; not yet rows in the spec's data model (W8-B spec issue).
  stats_days: [
    'round_id',
    'mode',
    'closes_at',
    'game_day',
    'outcome',
    'winner',
    'after_user',
    'started_at',
    'done_at',
  ],
  stats_wins: ['round_id', 'mode', 'user_id', 'stray_streak', 'best_stray_streak', 'entered_at'],
  stats_weeks: ['user_id', 'mode', 'iso_week', 'wins', 'net', 'updated_at'],
  // 0005_scheduler (W4-A): at-most-once operator transactions; not yet a row in the spec's data model.
  operator_txs: ['purpose', 'status', 'tx_json', 'tx_hash', 'created_at', 'updated_at'],
  // 0009_personhood (W5-B): admin flags and config, and deleted people's cap state; neither is a
  // row in the spec's data model yet (W5-B spec issue).
  config: ['key', 'value_json', 'updated_at', 'updated_by'],
  person_tombstones: [
    'person_id',
    'daily_stake_cap',
    'pending_cap',
    'pending_cap_effective_at',
    'created_at',
    // 0015 (W7-B): the deleted account, so re-verification carries its tickets (W7-B spec issue).
    'user_id',
  ],
  // 0017 (W8-A): split quality per settled mode of a daily round ("Question pipeline" step 5); not
  // yet a row in the spec's data model.
  question_splits: ['round_id', 'mode', 'question_id', 'split_quality', 'entrants', 'created_at'],
};

/** Primary keys the spec names ("PK (...)", or "(PK)" on a column). */
const SPEC_PRIMARY_KEYS: Record<string, readonly string[]> = {
  question_votes: ['question_id', 'user_id'],
  daily_grant_skips: ['user_id', 'round_id'],
  chain_events: ['chain_id', 'tx_hash', 'log_index'],
  indexer_checkpoints: ['chain_id', 'contract', 'block_number'],
  chain_event_removals: ['chain_id', 'tx_hash', 'log_index', 'revision'],
  sent_txs: ['chain_id', 'tx_hash', 'round_key'],
  settlement_holds: ['round_id', 'mode', 'reason'],
  round_modes: ['round_id', 'mode'],
  stakes_tickets: ['ticket_hash'],
  settlements: ['round_id', 'mode', 'proposal_seq'],
  point_balances: ['user_id', 'scope'],
  share_cards: ['share_id'],
  config: ['key'],
  person_tombstones: ['person_id'],
  question_splits: ['round_id', 'mode'],
};

interface KeySpec {
  table: string;
  columns: readonly string[];
  /** Partial index; the WHERE text must contain this. */
  where?: string;
}

/** Unique keys and partial unique indexes the spec names. */
const SPEC_UNIQUE: readonly KeySpec[] = [
  { table: 'users', columns: ['handle'] },
  { table: 'users', columns: ['person_id'] },
  { table: 'users', columns: ['ref_code'] },
  { table: 'identities', columns: ['provider', 'external_id'] },
  { table: 'stakes_tickets', columns: ['round_id', 'person_tag'], where: 'used_tx IS NOT NULL' },
  { table: 'entries', columns: ['round_id', 'mode', 'user_id'] },
  { table: 'entries', columns: ['tx_hash', 'log_index'] },
  { table: 'settlements', columns: ['round_id', 'mode'], where: 'superseded_at IS NULL' },
  { table: 'points_ledger', columns: ['user_id', 'scope', 'reason', 'ref_id'] },
  { table: 'share_cards', columns: ['round_id', 'mode', 'user_id', 'kind'] },
  { table: 'referrals', columns: ['referee_user_id'] },
];

/** Plain indexes the spec names. */
const SPEC_INDEXES: readonly KeySpec[] = [
  { table: 'stakes_tickets', columns: ['round_id', 'person_tag'] },
  // 0012 (W6-B).
  { table: 'stakes_tickets', columns: ['user_id', 'game_day'] },
];

interface IndexInfo {
  name: string;
  unique: boolean;
  partial: boolean;
  origin: string;
  columns: string[];
  sql: string | null;
}

async function columnsOf(table: string): Promise<{ name: string; pk: number }[]> {
  const { results } = await env.DB.prepare(`SELECT name, pk FROM pragma_table_info(?1)`)
    .bind(table)
    .all<{ name: string; pk: number }>();
  return results;
}

async function indexesOf(table: string): Promise<IndexInfo[]> {
  const { results: list } = await env.DB.prepare(
    'SELECT name, "unique" AS u, partial, origin FROM pragma_index_list(?1)',
  )
    .bind(table)
    .all<{ name: string; u: number; partial: number; origin: string }>();
  const out: IndexInfo[] = [];
  for (const ix of list) {
    const { results: cols } = await env.DB.prepare(
      'SELECT name FROM pragma_index_info(?1) ORDER BY seqno',
    )
      .bind(ix.name)
      .all<{ name: string }>();
    const sqlRow = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
    )
      .bind(ix.name)
      .first<{ sql: string | null }>();
    out.push({
      name: ix.name,
      unique: ix.u === 1,
      partial: ix.partial === 1,
      origin: ix.origin,
      columns: cols.map((c) => c.name),
      sql: sqlRow?.sql ?? null,
    });
  }
  return out;
}

async function tables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
  ).all<{ name: string }>();
  return results.map((r) => r.name).sort();
}

/** Runs a statement expected to violate a constraint; returns the error message. */
async function rejects(sql: string, ...params: unknown[]): Promise<string> {
  try {
    await env.DB.prepare(sql)
      .bind(...params)
      .run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`expected a constraint failure: ${sql}`);
}

describe('0001_init applies cleanly', () => {
  it('creates exactly the spec tables', async () => {
    expect(await tables()).toEqual(Object.keys(SPEC_COLUMNS).sort());
  });

  it('records the migration', async () => {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations').all<{
      name: string;
    }>();
    expect(results.map((r) => r.name)).toContain('0001_init.sql');
  });

  it('makes every table STRICT', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    ).all<{ name: string; strict: number }>();
    expect(results.filter((r) => r.strict !== 1).map((r) => r.name)).toEqual([]);
  });
});

describe.each(Object.entries(SPEC_COLUMNS))('table %s', (table, expected) => {
  it('has every spec column', async () => {
    const names = (await columnsOf(table)).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([...expected]));
    // Nothing beyond the spec: extra columns are spec changes.
    expect(names.filter((n) => !expected.includes(n))).toEqual([]);
  });

  if (SPEC_PRIMARY_KEYS[table]) {
    it('has the spec primary key', async () => {
      const pk = (await columnsOf(table))
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect(pk).toEqual(SPEC_PRIMARY_KEYS[table]);
    });
  }
});

describe('unique keys and indexes', () => {
  it.each(
    SPEC_UNIQUE.map(
      (k) => [`${k.table}(${k.columns.join(', ')})${k.where ? ' partial' : ''}`, k] as const,
    ),
  )('unique %s', async (_label, key) => {
    const match = (await indexesOf(key.table)).find(
      (ix) =>
        ix.unique &&
        ix.columns.join() === key.columns.join() &&
        ix.partial === (key.where !== undefined),
    );
    expect(match, `no unique index on ${key.table}(${key.columns.join(', ')})`).toBeDefined();
    if (key.where) expect(match?.sql).toContain(`WHERE ${key.where}`);
  });

  it.each(SPEC_INDEXES.map((k) => [`${k.table}(${k.columns.join(', ')})`, k] as const))(
    'index %s',
    async (_label, key) => {
      const match = (await indexesOf(key.table)).find(
        (ix) => !ix.unique && !ix.partial && ix.columns.join() === key.columns.join(),
      );
      expect(match).toBeDefined();
    },
  );
});

describe('constraints reject bad rows', () => {
  it('settlement_holds (0008): void_rate holds have no tx_hash; foreign_entry holds need one', async () => {
    const insert =
      'INSERT INTO settlement_holds (round_id, mode, reason, tx_hash, created_at) VALUES (?1, ?2, ?3, ?4, 0)';
    await env.DB.prepare(insert).bind('r-0008', 'free', 'void_rate', null).run();
    await env.DB.prepare(insert).bind('r-0008', 'stakes', 'foreign_entry', '0xabc').run();
    expect(await rejects(insert, 'r-0008', 'stakes', 'void_rate', '0xabc')).toContain(
      'CHECK constraint failed: settlement_holds_tx',
    );
    expect(await rejects(insert, 'r-0008', 'free', 'foreign_entry', null)).toContain(
      'CHECK constraint failed: settlement_holds_tx',
    );
    expect(await rejects(insert, 'r-0008', 'free', 'other', null)).toContain(
      'CHECK constraint failed',
    );
    expect(await rejects(insert, 'r-0008', 'free', 'void_rate', null)).toContain('UNIQUE');
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations').all<{
      name: string;
    }>();
    expect(results.map((r) => r.name)).toContain('0008_settlement.sql');
  });

  it('point_balances: balance >= 0', async () => {
    expect(
      await rejects(
        "INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES ('u', 'global', -1, 0)",
      ),
    ).toContain('CHECK constraint failed: point_balances_non_negative');
  });

  it('round_modes: the _proposed states are Stakes only', async () => {
    expect(
      await rejects(
        "INSERT INTO round_modes (round_id, mode, status) VALUES ('r', 'free', 'settle_proposed')",
      ),
    ).toContain('CHECK constraint failed');
    await env.DB.prepare(
      "INSERT INTO round_modes (round_id, mode, status) VALUES ('r', 'stakes', 'settle_proposed')",
    ).run();
  });

  it('round_modes: unknown status and missing final_at for terminal states', async () => {
    expect(
      await rejects(
        "INSERT INTO round_modes (round_id, mode, status) VALUES ('r2', 'free', 'open')",
      ),
    ).toContain('CHECK constraint failed');
    expect(
      await rejects(
        "INSERT INTO round_modes (round_id, mode, status) VALUES ('r2', 'free', 'settled')",
      ),
    ).toContain('CHECK constraint failed: round_modes_final_at');
  });

  it('questions: options_json has exactly 2 entries', async () => {
    expect(
      await rejects(
        'INSERT INTO questions (id, prompt, options_json, category, created_at) VALUES (\'q\', \'p\', \'[{"label":"a"},{"label":"b"},{"label":"c"}]\', \'food\', 0)',
      ),
    ).toContain('CHECK constraint failed: questions_two_options');
  });

  it('question_votes: value is +1 or -1', async () => {
    expect(
      await rejects(
        "INSERT INTO question_votes (question_id, user_id, value, created_at) VALUES ('q', 'u', 2, 0)",
      ),
    ).toContain('CHECK constraint failed');
  });

  it('identities: wallet external_id is lowercase; (provider, external_id) is unique', async () => {
    expect(
      await rejects(
        "INSERT INTO identities (id, user_id, provider, external_id) VALUES ('i1', 'u', 'wallet', '0xABCDEF')",
      ),
    ).toContain('identities_wallet_lowercase');
    await env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id) VALUES ('i1', 'u', 'wallet', '0xabcdef')",
    ).run();
    expect(
      await rejects(
        "INSERT INTO identities (id, user_id, provider, external_id) VALUES ('i2', 'u2', 'wallet', '0xabcdef')",
      ),
    ).toContain('UNIQUE constraint failed');
  });

  it('users: handle is unique case-insensitively; merged needs merged_into', async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, handle, ref_code, created_at) VALUES ('u1', 'flockstar', 'R1', 0)",
    ).run();
    expect(
      await rejects(
        "INSERT INTO users (id, handle, ref_code, created_at) VALUES ('u2', 'FlockStar', 'R2', 0)",
      ),
    ).toContain('UNIQUE constraint failed: users.handle');
    expect(
      await rejects(
        "INSERT INTO users (id, handle, ref_code, status, created_at) VALUES ('u3', 'h3', 'R3', 'merged', 0)",
      ),
    ).toContain('users_merged_into');
  });

  it('stakes_tickets: one used ticket per (round, person_tag), unused ones unrestricted', async () => {
    const ins = (hash: string, used: string | null) =>
      env.DB.prepare(
        "INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at, used_tx) VALUES (?1, 'r', 't', 'u', '0x1', 0, 0, ?2)",
      )
        .bind(hash, used)
        .run();
    await ins('h1', null);
    await ins('h2', null);
    await ins('h3', '0xtx1');
    await expect(ins('h4', '0xtx2')).rejects.toThrow('UNIQUE constraint failed');
  });

  it('0012: stakes_tickets.game_day is a YYYY-MM-DD date; users.age_attested_min is 18 (default) or 21', async () => {
    const ticket = (hash: string, day: string | null) =>
      env.DB.prepare(
        "INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at, game_day) VALUES (?1, 'r', 't', 'u', '0x1', 0, 0, ?2)",
      )
        .bind(hash, day)
        .run();
    await ticket('g1', '2026-10-08');
    await ticket('g2', null);
    await expect(ticket('g3', '2026-1-8')).rejects.toThrow('CHECK constraint failed');

    await env.DB.prepare(
      "INSERT INTO users (id, handle, ref_code, created_at) VALUES ('a18', 'a18', 'RA18', 0)",
    ).run();
    const age = () =>
      env.DB.prepare("SELECT age_attested_min FROM users WHERE id = 'a18'").first<{
        age_attested_min: number;
      }>();
    expect((await age())?.age_attested_min).toBe(18);
    await env.DB.prepare("UPDATE users SET age_attested_min = 21 WHERE id = 'a18'").run();
    expect((await age())?.age_attested_min).toBe(21);
    expect(await rejects("UPDATE users SET age_attested_min = 19 WHERE id = 'a18'")).toContain(
      'CHECK constraint failed',
    );
  });

  it('settlements: one current proposal per (round, mode); superseded ones are kept', async () => {
    const ins = (seq: number, superseded: number | null) =>
      env.DB.prepare(
        "INSERT INTO settlements (round_id, mode, proposal_seq, outcome, formula_version, tally_json, superseded_at) VALUES ('r', 'stakes', ?1, 'settled', 1, '{}', ?2)",
      )
        .bind(seq, superseded)
        .run();
    await ins(0, 1);
    await ins(1, null);
    await expect(ins(2, null)).rejects.toThrow('UNIQUE constraint failed');
  });

  it('entries: one per (round, mode, user); Free needs receipt_seq; Stakes needs chain coordinates', async () => {
    const free = (id: string, user: string, seq: number | null) =>
      env.DB.prepare(
        "INSERT INTO entries (id, round_id, mode, user_id, stake, commitment, receipt_seq, created_at) VALUES (?1, 'r', 'free', ?2, 10, '0xc', ?3, 0)",
      )
        .bind(id, user, seq)
        .run();
    await free('e1', 'u1', 0);
    await expect(free('e2', 'u1', 1)).rejects.toThrow('UNIQUE constraint failed');
    await expect(free('e3', 'u3', null)).rejects.toThrow('entries_free_receipt');
    expect(
      await rejects(
        "INSERT INTO entries (id, round_id, mode, user_id, person_tag, stake, commitment, created_at) VALUES ('e4', 'r', 'stakes', 'u4', '0xt', 5000000, '0xc', 0)",
      ),
    ).toContain('entries_stakes_chain');
  });

  it('points_ledger: append-only and one row per (user, scope, reason, ref)', async () => {
    const ins = (id: string) =>
      env.DB.prepare(
        "INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) VALUES (?1, 'u', 'global', 5, 'payout', 'r', 0)",
      )
        .bind(id)
        .run();
    await ins('l1');
    await expect(ins('l2')).rejects.toThrow('UNIQUE constraint failed: points_ledger.');
    expect(await rejects("UPDATE points_ledger SET delta = 6 WHERE id = 'l1'")).toContain(
      'append-only',
    );
    expect(await rejects("DELETE FROM points_ledger WHERE id = 'l1'")).toContain('append-only');
    expect(
      await rejects(
        "INSERT INTO points_ledger (id, user_id, scope, delta, reason, ref_id, created_at) VALUES ('l3', 'u', 'global', 5, 'bonus', 'r', 0)",
      ),
    ).toContain('CHECK constraint failed');
  });

  it('config: value_json is JSON; person_tombstones: a pending cap needs its effective time', async () => {
    expect(
      await rejects("INSERT INTO config (key, value_json, updated_at) VALUES ('k', 'not json', 0)"),
    ).toContain('CHECK constraint failed');
    expect(
      await rejects(
        "INSERT INTO person_tombstones (person_id, pending_cap, created_at) VALUES ('0x01', 5, 0)",
      ),
    ).toContain('person_tombstones_pending_cap_pair');
  });

  it('rounds: room rounds need room_id, and locked rounds are complete', async () => {
    expect(
      await rejects(
        "INSERT INTO rounds (id, kind, opens_at, closes_at) VALUES ('r1', 'room', 0, 1)",
      ),
    ).toContain('rounds_room_kind');
    expect(
      await rejects(
        "INSERT INTO rounds (id, kind, opens_at, closes_at, locked_at) VALUES ('r2', 'daily', 0, 1, 0)",
      ),
    ).toContain('rounds_locked_complete');
  });
});

describe('0011 (W6-A)', () => {
  it('Stakes entries are read in chain order through an index', async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM entries WHERE round_id = ?1 AND mode = 'stakes'
         AND (block_number > ?2 OR (block_number = ?2 AND log_index > ?3))
       ORDER BY block_number, log_index LIMIT 500`,
    )
      .bind('r', 0, 0)
      .all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join('\n');
    expect(details).toContain('entries_round_stakes_chain_idx');
    expect(details).not.toContain('TEMP B-TREE');
  });
});

describe('0013 (W6-D)', () => {
  it("GET /claims?wallet= finds a wallet's Stakes entries through an index", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT e.round_id FROM entries e JOIN rounds r ON r.id = e.round_id
       WHERE e.wallet = ?1 AND e.mode = 'stakes' AND r.kind = 'daily'`,
    )
      .bind('0x0000000000000000000000000000000000000001')
      .all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join('\n');
    expect(details).toContain('entries_stakes_wallet_idx');
    expect(details).not.toMatch(/SCAN e\b/);
  });
});

// W3-Z carry-over: 0002 rebuilt `users` to make `handle` nullable. Replay 0001's `users` and then
// 0002 on a renamed copy, with rows in it, and compare: every column's type, NOT NULL and default,
// every CHECK and index, and the rows themselves must survive; only `handle` loses NOT NULL.
describe('0002 (W3-A) against 0001: users', () => {
  const rename = (sql: string) =>
    sql.replace(/\busers_(\w+)/g, 'mig_users_$1').replace(/\busers\b/g, 'mig_users');
  const queriesOf = (name: string) => {
    const m = env.TEST_MIGRATIONS.find((x) => x.name === name);
    if (!m) throw new Error(`no migration ${name}`);
    return m.queries;
  };
  const columns = async () =>
    (
      await env.DB.prepare(
        'SELECT name, type, "notnull" AS nn, dflt_value, pk FROM pragma_table_info(\'mig_users\') ORDER BY cid',
      ).all<{ name: string; type: string; nn: number; dflt_value: string | null; pk: number }>()
    ).results;
  const checks = async () => {
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mig_users'",
    ).first<{ sql: string }>();
    // Each CHECK clause, whitespace-normalised (the table name differs only by the rebuild).
    return [...(row?.sql ?? '').matchAll(/CHECK\s*\(((?:[^()]|\([^()]*\))*)\)/g)]
      .map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim())
      .sort();
  };
  const indexes = async () =>
    (
      await env.DB.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mig_users' AND sql IS NOT NULL ORDER BY name",
      ).all<{ name: string; sql: string }>()
    ).results.map((r) => ({ name: r.name, sql: r.sql.replace(/\s+/g, ' ') }));
  const rows = async () =>
    (await env.DB.prepare('SELECT * FROM mig_users ORDER BY id').all()).results;

  it('keeps every column, CHECK, default, index and row; only handle becomes nullable', async () => {
    const v1 = queriesOf('0001_init.sql').filter((q) => /CREATE TABLE users\b|ON users \(/.test(q));
    expect(v1.length).toBeGreaterThanOrEqual(2);
    for (const q of v1) await env.DB.prepare(rename(q)).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mig_users (id, handle, ref_code, created_at) VALUES ('U1', 'ewe', 'R1', 1)",
      ),
      env.DB.prepare(
        'INSERT INTO mig_users (id, handle, display_name, avatar_url, role, status, merged_into, prefs_json, ' +
          'age_attested_at, tos_version, tos_accepted_at, kyc_status, person_id, person_verified_at, ref_code, ' +
          "coinbase_country, coinbase_region, created_at) VALUES ('U2', 'ram', 'Ram', 'https://x.test/a.png', " +
          "'admin', 'merged', 'U1', '{\"show_stakes_net\":true}', 5, 'v1', 6, 'verified', '0xp', 7, 'R2', 'US', 'NJ', 2)",
      ),
    ]);
    const before = {
      columns: await columns(),
      checks: await checks(),
      indexes: await indexes(),
      rows: await rows(),
    };

    for (const q of queriesOf('0002_auth.sql')) await env.DB.prepare(rename(q)).run();

    const after = {
      columns: await columns(),
      checks: await checks(),
      indexes: await indexes(),
      rows: await rows(),
    };
    expect(after.rows).toEqual(before.rows);
    expect(after.checks).toEqual(before.checks);
    expect(after.indexes).toEqual(before.indexes);
    expect(after.columns).toEqual(
      before.columns.map((c) => (c.name === 'handle' ? { ...c, nn: 0 } : c)),
    );
    expect(before.columns.find((c) => c.name === 'handle')?.nn).toBe(1);
    // The CHECKs still bite on the rebuilt table.
    await expect(
      env.DB.prepare(
        "INSERT INTO mig_users (id, ref_code, created_at, status) VALUES ('U3', 'R3', 3, 'merged')",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        "INSERT INTO mig_users (id, ref_code, created_at, role) VALUES ('U4', 'R4', 4, 'owner')",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await env.DB.prepare('DROP TABLE mig_users').run();
  });
});

describe('0015 (W7-B)', () => {
  it('person_tombstones.user_id; one pending merge per (kept, losing) pair; share cards by user', async () => {
    const insert = (id: string, status: string) =>
      env.DB.prepare(
        "INSERT INTO merges (id, kept_user_id, losing_user_id, identity_id, status, expires_at, created_at) VALUES (?1, 'K', 'L', 'i', ?2, 9, 1)",
      )
        .bind(id, status)
        .run();
    await insert('M1', 'pending');
    await expect(insert('M2', 'pending')).rejects.toThrow(/UNIQUE constraint failed/);
    await insert('M3', 'expired');
    await insert('M4', 'refused');
    await env.DB.prepare(
      "INSERT INTO person_tombstones (person_id, created_at, user_id) VALUES ('0xp15', 1, 'U15')",
    ).run();
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT round_id FROM share_cards WHERE user_id = 'U'",
    ).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join('\n')).toContain('share_cards_user_idx');
  });
});

describe('0016 (W6-F1 O1)', () => {
  const insert =
    'INSERT INTO settlement_holds (round_id, mode, reason, tx_hash, created_at, released_at, released_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)';
  const rows = () =>
    env.DB.prepare(
      "SELECT round_id, mode, reason, tx_hash, created_at, released_at, released_by FROM settlement_holds WHERE round_id LIKE 'r-0016%' ORDER BY round_id, mode, reason",
    )
      .all()
      .then((r) => r.results);

  it('settlement_holds takes refund_vetoed (no tx_hash), with the same columns, key and checks', async () => {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations').all<{
      name: string;
    }>();
    expect(results.map((r) => r.name)).toContain('0016_refund_vetoed_hold.sql');
    await env.DB.prepare(insert)
      .bind('r-0016-a', 'stakes', 'refund_vetoed', null, 1, null, null)
      .run();
    expect(
      await rejects(insert, 'r-0016-b', 'stakes', 'refund_vetoed', '0xabc', 1, null, null),
    ).toContain('CHECK constraint failed: settlement_holds_tx');
    expect(
      await rejects(insert, 'r-0016-a', 'stakes', 'refund_vetoed', null, 2, null, null),
    ).toContain('UNIQUE');
    expect(
      await rejects(insert, 'r-0016-b', 'stakes', 'refund_vetoed', null, 1, 5, null),
    ).toContain('CHECK constraint failed: settlement_holds_release');
    expect(await rejects(insert, 'r-0016-b', 'stakes', 'other', null, 1, null, null)).toContain(
      'CHECK constraint failed',
    );
    expect((await columnsOf('settlement_holds')).map((c) => [c.name, c.pk])).toEqual([
      ['round_id', 1],
      ['mode', 2],
      ['reason', 3],
      ['tx_hash', 0],
      ['created_at', 0],
      ['released_at', 0],
      ['released_by', 0],
    ]);
    expect((await indexesOf('settlement_holds')).map((i) => [i.origin, i.columns])).toEqual([
      ['pk', ['round_id', 'mode', 'reason']],
    ]);
    const strict = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settlement_holds'",
    ).first<{ sql: string }>();
    expect(strict?.sql).toMatch(/\)\s*STRICT$/);
  });

  it('the rebuild keeps every row as it was', async () => {
    await env.DB.batch([
      env.DB.prepare(insert).bind('r-0016-c', 'stakes', 'foreign_entry', '0xfe', 10, 20, 'admin-1'),
      env.DB.prepare(insert).bind('r-0016-c', 'free', 'void_rate', null, 11, null, null),
      env.DB.prepare(insert).bind('r-0016-d', 'stakes', 'refund_vetoed', null, 12, 30, 'admin-2'),
    ]);
    const before = await rows();
    // 0016's statements once more, on the rebuilt table: the same columns, so the rows carry over.
    const m = env.TEST_MIGRATIONS.find((x) => x.name === '0016_refund_vetoed_hold.sql');
    if (!m) throw new Error('0016 is not a migration');
    await env.DB.batch(m.queries.map((q) => env.DB.prepare(q)));
    expect(await rows()).toEqual(before);
    expect(before).toHaveLength(4);
  });
});

describe('0017 (W8-A)', () => {
  const q = (id: string, cols: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id,
      prompt: 'Tea or coffee?',
      options_json: '[{"label":"Tea"},{"label":"Coffee"}]',
      category: 'food',
      created_at: 0,
      ...cols,
    };
    const names = Object.keys(row);
    return [
      `INSERT INTO questions (${names.join(', ')}) VALUES (${names.map((_, i) => `?${i + 1}`).join(', ')})`,
      ...Object.values(row),
    ] as const;
  };
  const insert = async (id: string, cols: Record<string, unknown> = {}) => {
    const [sql, ...params] = q(id, cols);
    await env.DB.prepare(sql)
      .bind(...params)
      .run();
  };

  it('records the migration', async () => {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations').all<{
      name: string;
    }>();
    expect(results.map((r) => r.name)).toContain('0017_question_pipeline.sql');
  });

  it('category is one of the fixed list ("Core game rules" › Question format)', async () => {
    for (const c of ['food', 'life', 'tech', 'money', 'pop', 'hypothetical', 'other']) {
      await insert(`q17-cat-${c}`, { category: c });
    }
    for (const c of ['test', 'animals', 'Food', '']) {
      expect(await rejects(...q(`q17-bad-${c}`, { category: c }))).toContain(
        'CHECK constraint failed',
      );
    }
  });

  it('rejected_at and rejection_reason are set together, exactly when the status is rejected', async () => {
    await insert('q17-rej', {
      status: 'rejected',
      rejected_at: 5,
      rejection_reason: 'Not two-sided',
    });
    for (const [id, cols] of [
      ['q17-r1', { status: 'rejected' }],
      ['q17-r2', { status: 'rejected', rejected_at: 5 }],
      ['q17-r3', { status: 'rejected', rejection_reason: 'x' }],
      ['q17-r4', { status: 'queued', rejected_at: 5, rejection_reason: 'x' }],
      ['q17-r5', { status: 'submitted', rejection_reason: 'x' }],
    ] as const) {
      expect(await rejects(...q(id, cols))).toContain(
        'CHECK constraint failed: questions_rejection',
      );
    }
    // Un-rejecting clears both, or fails.
    expect(await rejects("UPDATE questions SET status = 'queued' WHERE id = 'q17-rej'")).toContain(
      'questions_rejection',
    );
    await env.DB.prepare(
      "UPDATE questions SET status = 'queued', rejected_at = NULL, rejection_reason = NULL WHERE id = 'q17-rej'",
    ).run();
  });

  it('needs_review is 0 or 1, and 1 only while submitted', async () => {
    await insert('q17-nr', { status: 'submitted', needs_review: 1 });
    await insert('q17-new');
    const row = await env.DB.prepare(
      "SELECT status, needs_review FROM questions WHERE id = 'q17-new'",
    ).first<{ status: string; needs_review: number }>();
    expect(row).toEqual({ status: 'submitted', needs_review: 0 });
    expect(await rejects(...q('q17-nr2', { status: 'queued', needs_review: 1 }))).toContain(
      'CHECK constraint failed: questions_review',
    );
    expect(await rejects(...q('q17-nr3', { status: 'submitted', needs_review: 2 }))).toContain(
      'CHECK constraint failed',
    );
    // Approving clears the flag in the same update, or fails.
    expect(await rejects("UPDATE questions SET status = 'queued' WHERE id = 'q17-nr'")).toContain(
      'questions_review',
    );
  });

  it('question_splits: mode, split_quality in [0, 1], entrants > 0, one row per (round, mode)', async () => {
    const split =
      'INSERT INTO question_splits (round_id, mode, question_id, split_quality, entrants, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0)';
    await env.DB.prepare(split).bind('r17', 'free', 'q', 0, 1).run();
    await env.DB.prepare(split).bind('r17', 'stakes', 'q', 1, 3).run();
    expect(await rejects(split, 'r17', 'free', 'q', 0.5, 2)).toContain('UNIQUE');
    expect(await rejects(split, 'r17b', 'rooms', 'q', 0.5, 2)).toContain('CHECK constraint failed');
    expect(await rejects(split, 'r17b', 'free', 'q', -0.01, 2)).toContain(
      'CHECK constraint failed',
    );
    expect(await rejects(split, 'r17b', 'free', 'q', 1.01, 2)).toContain('CHECK constraint failed');
    expect(await rejects(split, 'r17b', 'free', 'q', 0.5, 0)).toContain('CHECK constraint failed');
    expect((await indexesOf('question_splits')).map((i) => i.columns)).toContainEqual([
      'question_id',
    ]);
  });

  // The rebuild against the table it replaced: 0001's `questions` (unchanged until 0017) on a
  // renamed copy, with rows, then 0017's questions statements on it.
  it('the rebuild copies every row: a bad category becomes other, a rejected row gets its time and a reason', async () => {
    const rename = (sql: string) =>
      sql
        .replace(/\bquestions_(\w+)/g, 'mig_questions_$1')
        .replace(/\bquestions\b/g, 'mig_questions');
    const statement = (sql: string) => sql.replace(/^(\s*--[^\n]*\n)*\s*/, '');
    const queriesOf = (name: string) => {
      const m = env.TEST_MIGRATIONS.find((x) => x.name === name);
      if (!m) throw new Error(`no migration ${name}`);
      return m.queries;
    };
    const v1 = queriesOf('0001_init.sql').filter((x) =>
      /^CREATE (TABLE|INDEX \w+ ON) questions\b/.test(statement(x)),
    );
    expect(v1).toHaveLength(3);
    for (const x of v1) await env.DB.prepare(rename(x)).run();
    const opts = '[{"label":"Tea","emoji":"🍵"},{"label":"Coffee","emoji":"☕"}]';
    await env.DB.batch(
      [
        ['M1', null, 'animals', 'queued', null, 2.5, 10],
        ['M2', 'U1', 'food', 'rejected', '{"safe":false}', -1, 20],
        ['M3', 'U2', 'tech', 'used', null, 0, 30],
        ['M4', 'U3', 'test', 'submitted', null, 1, 40],
      ].map((r) =>
        env.DB.prepare(
          'INSERT INTO mig_questions (id, author_user_id, prompt, options_json, category, status, moderation_json, score, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
        ).bind(r[0], r[1], `p ${String(r[0])}`, opts, r[2], r[3], r[4], r[5], r[6]),
      ),
    );

    const v17 = queriesOf('0017_question_pipeline.sql').filter((x) =>
      /^(CREATE TABLE questions_new|INSERT INTO questions_new|DROP TABLE questions\b|ALTER TABLE questions_new|CREATE INDEX \w+ ON questions\b)/.test(
        statement(x),
      ),
    );
    expect(v17).toHaveLength(8);
    for (const x of v17) await env.DB.prepare(rename(x)).run();

    const { results } = await env.DB.prepare(
      'SELECT id, author_user_id, category, status, moderation_json, score, created_at, needs_review, rejection_reason, rejected_at FROM mig_questions ORDER BY id',
    ).all();
    const common = { needs_review: 0, moderation_json: null };
    expect(results).toEqual([
      {
        ...common,
        id: 'M1',
        author_user_id: null,
        category: 'other',
        status: 'queued',
        score: 2.5,
        created_at: 10,
        rejection_reason: null,
        rejected_at: null,
      },
      {
        ...common,
        id: 'M2',
        author_user_id: 'U1',
        category: 'food',
        status: 'rejected',
        moderation_json: '{"safe":false}',
        score: -1,
        created_at: 20,
        rejection_reason: 'Rejected',
        rejected_at: 20,
      },
      {
        ...common,
        id: 'M3',
        author_user_id: 'U2',
        category: 'tech',
        status: 'used',
        score: 0,
        created_at: 30,
        rejection_reason: null,
        rejected_at: null,
      },
      {
        ...common,
        id: 'M4',
        author_user_id: 'U3',
        category: 'other',
        status: 'submitted',
        score: 1,
        created_at: 40,
        rejection_reason: null,
        rejected_at: null,
      },
    ]);
    // The rebuilt table has the new CHECKs.
    await expect(
      env.DB.prepare(
        "INSERT INTO mig_questions (id, prompt, options_json, category, created_at) VALUES ('M5', 'p', '[1,2]', 'test', 0)",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await env.DB.prepare('DROP TABLE mig_questions').run();
  });
});

describe('0018 (W8-B)', () => {
  it('stats_days: one day in progress per mode, one row per (mode, closes_at), a winner iff settled', async () => {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations').all<{
      name: string;
    }>();
    expect(results.map((r) => r.name)).toContain('0018_stats.sql');
    const insert = `INSERT INTO stats_days (round_id, mode, closes_at, game_day, outcome, winner,
      started_at, done_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)`;
    const run = (...p: unknown[]) =>
      env.DB.prepare(insert)
        .bind(...p)
        .run();
    await run('d18-a', 'free', 100, '2026-10-01', 'settled', 0, 5);
    await run('d18-b', 'free', 200, '2026-10-02', 'refunded', null, null);
    expect(await rejects(insert, 'd18-c', 'free', 300, '2026-10-03', 'voided', null, null)).toMatch(
      /UNIQUE constraint failed/,
    );
    expect(await rejects(insert, 'd18-c', 'free', 200, '2026-10-03', 'voided', null, 6)).toMatch(
      /UNIQUE constraint failed/,
    );
    await run('d18-c', 'stakes', 300, '2026-10-03', 'voided', null, null);
    expect(await rejects(insert, 'd18-d', 'free', 400, '2026-10-04', 'settled', null, 7)).toMatch(
      /CHECK constraint failed/,
    );
    expect(await rejects(insert, 'd18-d', 'free', 400, '2026-10-04', 'refunded', 1, 7)).toMatch(
      /CHECK constraint failed/,
    );
    expect(await rejects(insert, 'd18-d', 'free', 400, '2026/10/04', 'voided', null, 7)).toMatch(
      /CHECK constraint failed/,
    );
  });

  it('stats_wins and stats_weeks check their values; referrals.reward_week is an ISO week', async () => {
    expect(
      await rejects(
        "INSERT INTO stats_wins (round_id, mode, user_id, stray_streak, best_stray_streak, entered_at) VALUES ('r', 'free', 'u', 3, 2, 1)",
      ),
    ).toMatch(/CHECK constraint failed/);
    expect(
      await rejects(
        "INSERT INTO stats_weeks (user_id, mode, iso_week, wins, net, updated_at) VALUES ('u', 'free', '2026-41', 1, 0, 1)",
      ),
    ).toMatch(/CHECK constraint failed/);
    expect(
      await rejects(
        "INSERT INTO referrals (referrer_user_id, referee_user_id, status, created_at, reward_week) VALUES ('a', 'b', 'pending', 1, 'W41')",
      ),
    ).toMatch(/CHECK constraint failed/);
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT user_id FROM user_stats WHERE mode = 'free' ORDER BY best_stray_streak DESC, stray_streak DESC, rounds_played DESC LIMIT 10",
    ).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join('\n')).toContain('user_stats_streaks_idx');
  });
});

describe('0020 (W7-F1 R18)', () => {
  it('indexer_state.last_block_timestamp: nullable Unix seconds; a row stored before it keeps NULL', async () => {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations').all<{
      name: string;
    }>();
    expect(results.map((r) => r.name)).toContain('0020_indexer_block_timestamp.sql');
    const col = await env.DB.prepare(
      "SELECT type, \"notnull\" AS nn, dflt_value FROM pragma_table_info('indexer_state') WHERE name = 'last_block_timestamp'",
    ).first();
    expect(col).toEqual({ type: 'INTEGER', nn: 0, dflt_value: null });

    // 0020 on a copy of 0001's indexer_state holding a row: the row stays, with no timestamp.
    const rename = (sql: string) => sql.replace(/\bindexer_state\b/g, 'mig_indexer_state');
    const queriesOf = (name: string) => {
      const m = env.TEST_MIGRATIONS.find((x) => x.name === name);
      if (!m) throw new Error(`no migration ${name}`);
      return m.queries;
    };
    const v1 = queriesOf('0001_init.sql').filter((q) => /CREATE TABLE indexer_state\b/.test(q));
    expect(v1).toHaveLength(1);
    for (const q of v1) await env.DB.prepare(rename(q)).run();
    await env.DB.prepare(
      "INSERT INTO mig_indexer_state (chain_id, contract, last_block_number, last_block_hash, updated_at) VALUES (1, '0xe', 7, '0xh', 9)",
    ).run();
    for (const q of queriesOf('0020_indexer_block_timestamp.sql')) {
      await env.DB.prepare(rename(q)).run();
    }
    expect(await env.DB.prepare('SELECT * FROM mig_indexer_state').all()).toMatchObject({
      results: [
        {
          chain_id: 1,
          contract: '0xe',
          last_block_number: 7,
          last_block_hash: '0xh',
          last_block_timestamp: null,
          updated_at: 9,
        },
      ],
    });
    expect(
      await rejects(
        "INSERT INTO mig_indexer_state (chain_id, contract, last_block_number, last_block_hash, last_block_timestamp, updated_at) VALUES (2, '0xe', 7, '0xh', -1, 9)",
      ),
    ).toContain('CHECK constraint failed');
    await env.DB.prepare('DROP TABLE mig_indexer_state').run();
  });
});

describe('fixture', () => {
  it('seeds against the schema', async () => {
    const f = await seedFixture(env.DB);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM round_modes WHERE round_id = ?1')
      .bind(f.round.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});
