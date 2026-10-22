// Test-time bindings: the watcher's Env plus the test-only bindings from vitest.config.ts.
import type { D1Migration } from 'cloudflare:test';
import type { Env } from '../src/env.js';

/** One wrangler environment as test/isolation.test.ts sees it (built in vitest.config.ts). */
export interface WranglerEnvSummary {
  name: string;
  workersDev: boolean | null;
  routes: unknown[];
  vars: Record<string, unknown>;
  d1: { binding: string; databaseName: string; migrationsDir: string | null }[];
  otherBindings: number;
  crons: string[];
}

type WatcherEnv = Env;

declare global {
  /** Vite's `import.meta.glob` (resolved at transform time), as test/isolation.test.ts uses it. */
  interface ImportMeta {
    glob: (
      pattern: string,
      opts: { query: '?raw'; import: 'default'; eager: true },
    ) => Record<string, unknown>;
  }
  namespace Cloudflare {
    interface Env extends WatcherEnv {
      /** The watcher's migrations, from readD1Migrations in vitest.config.ts. */
      TEST_MIGRATIONS: D1Migration[];
      /** JSON of Record<'local' | 'staging' | 'production', WranglerEnvSummary>. */
      TEST_WRANGLER: string;
      /** JSON of apps/watcher/package.json (the dependency rule in test/isolation.test.ts). */
      TEST_PACKAGE_JSON: string;
    }
  }
}
