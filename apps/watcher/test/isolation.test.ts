// The watcher is independent of the backend or it is worth nothing (spec "Architecture": a separate
// account; plan.md 4.4). These tests hold that line in the places a future change would quietly
// cross it: its bindings, its database, its dependencies and its imports.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WranglerEnvSummary } from './env.d.ts';

const ENVIRONMENTS = ['local', 'staging', 'production'] as const;
const wrangler = JSON.parse(env.TEST_WRANGLER) as Record<
  (typeof ENVIRONMENTS)[number],
  WranglerEnvSummary
>;

/** The only shared code the watcher may use (wave-10.md "W10-B"). */
const ALLOWED_WORKSPACE_DEPS = [
  '@flocked/abi',
  '@flocked/settle',
  '@flocked/tlock',
  '@flocked/verify',
];

const sources = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('the watcher holds no binding to the backend', () => {
  it.each(ENVIRONMENTS)('%s has one D1 binding and nothing else', (name) => {
    const c = wrangler[name];
    expect(c.d1.map((d) => d.binding)).toEqual(['DB']);
    // No KV, R2, service binding, Durable Object or queue: nothing of the API's is reachable.
    expect(c.otherBindings).toBe(0);
  });

  it.each(ENVIRONMENTS)('%s uses the watcher’s own database, not the API’s', (name) => {
    const c = wrangler[name];
    const db = c.d1[0];
    expect(db?.databaseName).toMatch(/^flocked-watcher-/);
    // Its own migrations directory: the watcher owns its schema.
    expect(db?.migrationsDir).toBe('migrations');
  });

  it.each(ENVIRONMENTS)('%s runs the one-minute tick', (name) => {
    expect(wrangler[name].crons).toEqual(['* * * * *']);
  });

  it('reads the game only over a public API base, with its own RPC', () => {
    for (const name of ENVIRONMENTS) {
      const vars = wrangler[name].vars;
      expect(String(vars.API_BASE_URL)).toMatch(/\/api\/v1$/);
      expect(vars.BASE_RPC_URL).toBeTruthy();
    }
  });

  it('keeps every secret out of wrangler.jsonc', () => {
    for (const name of ENVIRONMENTS) {
      const keys = Object.keys(wrangler[name].vars);
      expect(keys).not.toContain('WATCHER_KEY');
      expect(keys).not.toContain('PAGER_WEBHOOK_URL');
      expect(keys).not.toContain('PAGER_WEBHOOK_TOKEN');
    }
  });

  it('serves verdicts publicly once deployed', () => {
    expect(wrangler.staging.workersDev).toBe(true);
    expect(wrangler.production.workersDev).toBe(true);
  });
});

describe('the watcher’s own schema', () => {
  it('creates only its own tables', () => {
    const sql = env.TEST_MIGRATIONS.map((m) => m.queries.join('\n')).join('\n');
    const tables = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]).sort();
    expect(tables).toEqual(['pages', 'proposals', 'round_snapshots', 'round_state', 'verdicts']);
  });
});

describe('the watcher’s only shared code is the four published packages', () => {
  it('declares nothing else from the workspace', () => {
    const pkg = JSON.parse(env.TEST_PACKAGE_JSON) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const workspace = Object.keys(pkg.dependencies).filter((d) => d.startsWith('@flocked/'));
    expect(workspace.sort()).toEqual(ALLOWED_WORKSPACE_DEPS);
    expect(Object.keys(pkg.devDependencies).some((d) => d.startsWith('@flocked/'))).toBe(false);
  });

  it('imports nothing else, and nothing from outside the package', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    for (const [path, text] of Object.entries(sources)) {
      // Static `from '…'` and dynamic `import('…')` alike.
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(
        (m) => m[1] ?? '',
      );
      for (const s of specifiers) {
        if (s.startsWith('@flocked/')) {
          expect(ALLOWED_WORKSPACE_DEPS, `${path} imports ${s}`).toContain(s);
        }
        // A relative import may never climb out of apps/watcher/src, and nothing reaches the API.
        expect(s.startsWith('../../'), `${path} imports ${s}`).toBe(false);
        expect(s.includes('apps/api'), `${path} imports ${s}`).toBe(false);
      }
    }
  });
});
