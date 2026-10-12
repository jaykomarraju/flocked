// The signer's tests run inside workerd through @cloudflare/vitest-plugin, against its real
// wrangler.jsonc (top level = `local`), with apps/api's D1 migrations applied to a fresh D1 per test
// file (test/setup.ts). The signer never migrates D1 itself: apps/api owns the schema.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { unstable_readConfig } from 'wrangler';
import { defineConfig } from 'vitest/config';

const configPath = './wrangler.jsonc';
const ENVIRONMENTS = ['local', 'staging', 'production'] as const;

/** The subset of wrangler's resolved config test/isolation.test.ts checks (NFR-7). */
interface ResolvedWranglerConfig {
  name: string;
  workers_dev: boolean | undefined;
  routes: unknown[] | undefined;
  vars: Record<string, unknown>;
  d1_databases: { binding: string; migrations_dir?: string }[];
  kv_namespaces: unknown[];
  r2_buckets: unknown[];
  services: unknown[];
  durable_objects: { bindings: unknown[] };
  queues: { producers?: unknown[]; consumers?: unknown[] };
  triggers: { crons?: string[] };
}

/** Each wrangler environment's bindings and vars, as JSON (Miniflare text binding). */
function wranglerSummary(): string {
  const summary = Object.fromEntries(
    ENVIRONMENTS.map((name) => {
      const c = unstable_readConfig(
        { config: configPath, env: name === 'local' ? undefined : name },
        {},
      ) as unknown as ResolvedWranglerConfig;
      return [
        name,
        {
          name: c.name,
          workersDev: c.workers_dev ?? null,
          routes: c.routes ?? [],
          vars: c.vars,
          d1: c.d1_databases.map((d) => ({
            binding: d.binding,
            migrationsDir: d.migrations_dir ?? null,
          })),
          otherBindings:
            c.kv_namespaces.length +
            c.r2_buckets.length +
            c.services.length +
            c.durable_objects.bindings.length +
            (c.queues.producers?.length ?? 0) +
            (c.queues.consumers?.length ?? 0),
          crons: c.triggers.crons ?? [],
        },
      ];
    }),
  );
  return JSON.stringify(summary);
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    decodeURIComponent(new URL('../api/migrations', import.meta.url).pathname),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath },
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_WRANGLER: wranglerSummary(),
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      testTimeout: 30_000,
      // @flocked/shared reaches @openzeppelin/merkle-tree (through @flocked/settle), which is
      // CommonJS that workerd's module fallback cannot interop; Vite pre-bundles it, as
      // apps/api/vitest.config.ts does (wrangler's esbuild does the same for the deployed Worker).
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: ['@flocked/shared > @flocked/settle > @openzeppelin/merkle-tree'],
          },
        },
      },
    },
  };
});
