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
  ],
  question_votes: ['question_id', 'user_id', 'value', 'created_at'],
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
  ],
  entries: [
    'id',
    'round_id',
    'mode',
    'user_id',
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
  indexer_state: ['chain_id', 'contract', 'last_block_number', 'last_block_hash', 'updated_at'],
  anchors: ['id', 'kind', 'round_keys_json', 'tx_hash', 'block_timestamp', 'created_at'],
  audit_log: ['id', 'actor', 'action', 'target', 'data_json', 'created_at'],
};

/** Primary keys the spec names ("PK (...)", or "(PK)" on a column). */
const SPEC_PRIMARY_KEYS: Record<string, readonly string[]> = {
  question_votes: ['question_id', 'user_id'],
  round_modes: ['round_id', 'mode'],
  stakes_tickets: ['ticket_hash'],
  settlements: ['round_id', 'mode', 'proposal_seq'],
  point_balances: ['user_id', 'scope'],
  share_cards: ['share_id'],
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

describe('fixture', () => {
  it('seeds against the schema', async () => {
    const f = await seedFixture(env.DB);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM round_modes WHERE round_id = ?1')
      .bind(f.round.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});
