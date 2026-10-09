// Migration 0002_auth: applies on top of 0001 and leaves `users` as 0001 defined it except that
// `handle` is nullable (new accounts pick a handle later).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

async function insertUser(id: string, handle: string | null, ref: string) {
  return env.DB.prepare(
    'INSERT INTO users (id, handle, ref_code, created_at) VALUES (?1, ?2, ?3, 1)',
  )
    .bind(id, handle, ref)
    .run();
}

describe('0002_auth', () => {
  it('is recorded after 0001', async () => {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{
      name: string;
    }>();
    const names = results.map((r) => r.name);
    expect(names.indexOf('0002_auth.sql')).toBeGreaterThan(names.indexOf('0001_init.sql'));
  });

  it('users stays STRICT with its indexes; handle is nullable and still unique case-insensitively', async () => {
    const table = await env.DB.prepare(
      "SELECT strict FROM pragma_table_list WHERE name = 'users'",
    ).first<{ strict: number }>();
    expect(table?.strict).toBe(1);
    const { results: cols } = await env.DB.prepare(
      'SELECT name, "notnull" AS nn FROM pragma_table_info(\'users\')',
    ).all<{ name: string; nn: number }>();
    expect(cols.find((c) => c.name === 'handle')?.nn).toBe(0);
    expect(
      cols
        .filter((c) => c.nn === 1)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['created_at', 'id', 'prefs_json', 'ref_code', 'role', 'status'].sort());
    const { results: idx } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(idx.map((i) => i.name)).toEqual([
      'users_handle',
      'users_merged_into_idx',
      'users_person_id',
      'users_ref_code',
    ]);

    await insertUser('01K7000000000000000000MIG1', null, 'MIGREF01');
    await insertUser('01K7000000000000000000MIG2', null, 'MIGREF02');
    await insertUser('01K7000000000000000000MIG3', 'flock', 'MIGREF03');
    await expect(insertUser('01K7000000000000000000MIG4', 'FLOCK', 'MIGREF04')).rejects.toThrow(
      /UNIQUE constraint failed: users.handle/,
    );
    await expect(
      env.DB.prepare(
        "INSERT INTO users (id, ref_code, created_at, status) VALUES ('01K7000000000000000000MIG5', 'MIGREF05', 1, 'merged')",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
