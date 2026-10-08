// Test-time bindings. In @cloudflare/vitest-plugin 1.x, `env` from 'cloudflare:test' (and from
// 'cloudflare:workers') is typed as `Cloudflare.Env`; it replaces the 0.x `ProvidedEnv` interface,
// so the API `Env` plus the test-only bindings are merged into `Cloudflare.Env` here.
import type { D1Migration } from 'cloudflare:test';
import type { Env } from '../src/env.js';
import type * as MainModule from '../src/index.js';

/** `JSON.parse(env.TEST_WRANGLER)`. */
export type WranglerSummary = Record<'local' | 'staging' | 'production', WranglerEnvSummary>;

/** One wrangler environment as test/worker.test.ts sees it (built in vitest.config.ts). */
export interface WranglerEnvSummary {
  name: string;
  vars: Record<string, unknown>;
  crons: string[];
  limits: { cpu_ms?: number } | null;
  producers: { binding: string; queue: string }[];
  consumers: {
    queue: string;
    max_batch_size?: number;
    max_batch_timeout?: number;
    max_retries?: number;
    max_concurrency?: number | null;
    retry_delay?: number;
    dead_letter_queue?: string;
  }[];
  durableObjects: { name: string; className: string }[];
  sqliteClasses: string[];
}

type ApiEnv = Env;

declare global {
  namespace Cloudflare {
    interface Env extends ApiEnv {
      /** Set in vitest.config.ts from readD1Migrations('migrations'). */
      TEST_MIGRATIONS: D1Migration[];
      /** JSON of WranglerSummary: wrangler.jsonc per environment, parsed by wrangler in vitest.config.ts. */
      TEST_WRANGLER: string;
    }
    /** Types `exports` from 'cloudflare:workers' (the Worker's own entry, as the tests call it). */
    interface GlobalProps {
      mainModule: typeof MainModule;
    }
  }
}
