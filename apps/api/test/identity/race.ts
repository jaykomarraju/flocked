// A D1 seam for race tests (W7-F1): runs a racing change (`hook`, written through the global
// `env.DB`) after the code under test has read what it checks and just before its guarded write, the
// order in which only a guard inside the write itself refuses. The env's `DB` is swapped for a thin
// wrapper until `restore()`; nothing else about the env changes (its deps stay attached).
//   - `{ batchOf: n }`: before the first `batch()` of at least n statements;
//   - `{ sql: /re/ }`: before the first run of a statement whose SQL matches (not inside a batch).
import { env } from 'cloudflare:test';

export interface Race {
  /** Whether the hook ran. */
  fired: () => boolean;
  restore: () => void;
}

export function raceBefore(
  e: { DB: D1Database },
  when: { batchOf: number } | { sql: RegExp },
  hook: () => Promise<unknown>,
): Race {
  const db = e.DB;
  let fired = false;
  const fire = async () => {
    if (fired) return;
    fired = true;
    await hook();
  };
  const watched = (stmt: D1PreparedStatement): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => watched(stmt.bind(...values)),
      first: async (column?: string) => {
        await fire();
        return column === undefined ? stmt.first() : stmt.first(column);
      },
      run: async () => {
        await fire();
        return stmt.run();
      },
      all: async () => {
        await fire();
        return stmt.all();
      },
      raw: async () => {
        await fire();
        return stmt.raw();
      },
    }) as unknown as D1PreparedStatement;
  const raced = {
    prepare: (query: string) => {
      const stmt = db.prepare(query);
      return 'sql' in when && when.sql.test(query) ? watched(stmt) : stmt;
    },
    batch: async (statements: D1PreparedStatement[]) => {
      if ('batchOf' in when && statements.length >= when.batchOf) await fire();
      return db.batch(statements);
    },
    exec: (query: string) => db.exec(query),
    dump: () => db.dump(),
    withSession: (constraint?: string) => db.withSession(constraint),
  } as unknown as D1Database;
  Object.assign(e, { DB: raced });
  return { fired: () => fired, restore: () => Object.assign(e, { DB: db }) };
}

/** Sets a user's status directly (a suspension, or what `DELETE /me` leaves). */
export async function setStatus(userId: string, status: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET status = ?2 WHERE id = ?1').bind(userId, status).run();
}
