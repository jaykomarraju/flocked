// The watcher's tests run inside workerd through @cloudflare/vitest-plugin, against its real
// wrangler.jsonc (top level = `local`) and its OWN D1 migrations: it shares no schema with apps/api.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { unstable_readConfig } from 'wrangler';
import { defineConfig } from 'vitest/config';

const configPath = './wrangler.jsonc';
const ENVIRONMENTS = ['local', 'staging', 'production'] as const;

/** The subset of wrangler's resolved config test/isolation.test.ts checks. */
interface ResolvedWranglerConfig {
  name: string;
  workers_dev: boolean | undefined;
  routes: unknown[] | undefined;
  vars: Record<string, unknown>;
  d1_databases: { binding: string; database_name: string; migrations_dir?: string }[];
  kv_namespaces: unknown[];
  r2_buckets: unknown[];
  services: unknown[];
  durable_objects: { bindings: unknown[] };
  queues: { producers?: unknown[]; consumers?: unknown[] };
  triggers: { crons?: string[] };
}

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
            databaseName: d.database_name,
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
    decodeURIComponent(new URL('migrations', import.meta.url).pathname),
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
            TEST_PACKAGE_JSON: JSON.stringify(
              JSON.parse(
                await (
                  await import('node:fs/promises')
                ).readFile(new URL('package.json', import.meta.url), 'utf8'),
              ),
            ),
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      // tlock encryption and decryption are real BLS work; the fixture seals a round of entries.
      testTimeout: 120_000,
      hookTimeout: 120_000,
      // @openzeppelin/merkle-tree (via @flocked/settle) and tlock-js (via @flocked/tlock) are
      // CommonJS that workerd's module fallback cannot interop; Vite pre-bundles them to ESM, as
      // apps/api/vitest.config.ts does (wrangler's esbuild does the same for the deployed Worker).
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: [
              '@flocked/settle > @openzeppelin/merkle-tree',
              '@flocked/shared > @flocked/settle > @openzeppelin/merkle-tree',
              '@flocked/tlock > tlock-js/age/age-encrypt-decrypt.js',
              '@flocked/tlock > tlock-js/crypto/ibe.js',
              '@flocked/tlock > tlock-js/drand/timelock-encrypter.js',
            ],
            rolldownOptions: { external: ['crypto'] },
          },
        },
      },
    },
  };
});
