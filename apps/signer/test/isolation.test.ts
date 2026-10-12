// NFR-7 (signer isolation), the signer's half: in every environment the signer has no route, no
// workers.dev URL and no binding but the API's D1 (read only), its vars hold no secret, its code reads
// only its own vars, D1 and TICKET_SIGNER_KEY, and the only SQL it can run is two fixed SELECTs.
// apps/api/test/stakes/isolation.test.ts is the other half (the API has no access to the key).
import { env } from 'cloudflare:test';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Env } from '../src/env.js';
import { SIGNER_SQL } from '../src/store.js';
import type { WranglerEnvSummary } from './env.js';

const wrangler = JSON.parse(env.TEST_WRANGLER) as Record<string, WranglerEnvSummary>;

/** The signer's source files, as text (Vite's raw glob). */
const SOURCES = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Everything the signer may read from `env`. TICKET_SIGNER_KEY is the only secret. */
const ENV_KEYS = ['DB', 'ENVIRONMENT', 'CHAIN_ID', 'LOCAL_DEPLOYMENT', 'TICKET_SIGNER_KEY'];
const SECRETS = ['TICKET_SIGNER_KEY'];

describe('NFR-7: the signer holds only TICKET_SIGNER_KEY', () => {
  it('Env declares exactly the D1 binding, the public vars and the one secret', () => {
    expectTypeOf<keyof Env>().toEqualTypeOf<
      'DB' | 'ENVIRONMENT' | 'CHAIN_ID' | 'LOCAL_DEPLOYMENT' | 'TICKET_SIGNER_KEY'
    >();
    expect(ENV_KEYS.filter((k) => !SECRETS.includes(k))).not.toContain('TICKET_SIGNER_KEY');
  });

  it.each(['local', 'staging', 'production'])(
    '%s: no route, no workers.dev, D1 only, and vars that are not secrets',
    (name) => {
      const c = wrangler[name];
      expect(c, name).toBeDefined();
      if (!c) return;
      expect(c.workersDev).toBe(false);
      expect(c.routes).toEqual([]);
      expect(c.crons).toEqual([]);
      expect(c.otherBindings).toBe(0);
      // The API's D1, never migrated from here.
      expect(c.d1).toEqual([{ binding: 'DB', migrationsDir: null }]);
      expect(Object.keys(c.vars).sort()).toEqual(['CHAIN_ID', 'ENVIRONMENT']);
      for (const v of Object.values(c.vars)) expect(String(v)).not.toMatch(/[0-9a-fA-F]{64}/);
    },
  );

  it('the code reads nothing from env but its bindings, vars and TICKET_SIGNER_KEY', () => {
    const read = new Set<string>();
    for (const text of Object.values(SOURCES)) {
      for (const m of String(text).matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) read.add(m[1]!);
    }
    expect([...read].filter((k) => !ENV_KEYS.includes(k))).toEqual([]);
    expect(read).toContain('TICKET_SIGNER_KEY');
  });
});

describe('the D1 binding is used read only', () => {
  it('only src/store.ts prepares SQL, and it never batches, execs, dumps or opens a session', () => {
    const files = Object.entries(SOURCES).map(([path, text]) => [path, String(text)] as const);
    expect(files.length).toBeGreaterThan(3);
    for (const [path, text] of files) {
      if (!path.endsWith('/store.ts')) expect(text, path).not.toMatch(/\.prepare\(/);
      expect(text, path).not.toMatch(/\.(batch|exec|dump|withSession)\(/);
      expect(text, path).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/);
    }
  });

  it('every statement it can run is one SELECT', () => {
    for (const sql of SIGNER_SQL) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toContain(';');
    }
  });
});
