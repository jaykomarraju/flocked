// Every apps/api test runs inside workerd through @cloudflare/vitest-plugin, against the real
// wrangler.jsonc (top level = the `local` environment) plus the test-only bindings below.
//
// Bindings in tests: D1, R2, KV, Durable Objects, Queues (producers), Analytics Engine, send_email
// and the static-assets Fetcher are Miniflare's local simulators. AI and Vectorize have no local
// simulator; with `remoteBindings: false` they exist but throw "needs to be run remotely" when
// used, so code that needs them takes them as injectable dependencies and tests pass fakes.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { unstable_readConfig } from 'wrangler';
import { defineConfig } from 'vitest/config';

const configPath = './wrangler.jsonc';
const ENVIRONMENTS = ['local', 'staging', 'production'] as const;

/** The subset of wrangler's resolved config these tests read (its own types need Node's). */
interface ResolvedWranglerConfig {
  name: string;
  vars: Record<string, unknown>;
  triggers: { crons?: string[] };
  limits?: { cpu_ms?: number };
  queues: {
    producers?: { binding: string; queue: string }[];
    consumers?: Record<string, unknown>[];
  };
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { new_sqlite_classes?: string[] }[];
}

function readWrangler(env: string | undefined): ResolvedWranglerConfig {
  const config: unknown = unstable_readConfig({ config: configPath, env }, {});
  return config as ResolvedWranglerConfig;
}

/**
 * The parts of each wrangler environment that test/worker.test.ts checks against the code, as JSON
 * (Miniflare text binding; test/env.d.ts types the parsed shape).
 */
function wranglerSummary(): string {
  const summary = Object.fromEntries(
    ENVIRONMENTS.map((name) => {
      const c = readWrangler(name === 'local' ? undefined : name);
      return [
        name,
        {
          name: c.name,
          vars: c.vars,
          crons: c.triggers.crons ?? [],
          limits: c.limits ?? null,
          producers: (c.queues.producers ?? []).map((p) => ({
            binding: p.binding,
            queue: p.queue,
          })),
          consumers: c.queues.consumers ?? [],
          durableObjects: c.durable_objects.bindings.map((b) => ({
            name: b.name,
            className: b.class_name,
          })),
          sqliteClasses: c.migrations.flatMap((m) => m.new_sqlite_classes ?? []),
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
        // Never reach Cloudflare from tests.
        remoteBindings: false,
        miniflare: {
          bindings: {
            // Applied to each test file's fresh D1 by test/setup.ts.
            TEST_MIGRATIONS: migrations,
            // wrangler.jsonc as parsed by wrangler, per environment (config drift checks).
            TEST_WRANGLER: wranglerSummary(),
            // A fixed, known value for src/lib/turnstile.ts tests (not a real key).
            TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      testTimeout: 30_000,
      // @openzeppelin/merkle-tree (via @flocked/settle) and tlock-js (via @flocked/tlock) are
      // CommonJS with CommonJS dependencies that workerd's module fallback cannot interop; Vite
      // pre-bundles them to ESM (wrangler's esbuild does the same for the deployed Worker), as
      // packages/tlock/vitest.config.ts does.
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: [
              '@flocked/settle > @openzeppelin/merkle-tree',
              '@flocked/tlock > tlock-js/age/age-encrypt-decrypt.js',
              '@flocked/tlock > tlock-js/crypto/ibe.js',
              '@flocked/tlock > tlock-js/drand/timelock-encrypter.js',
            ],
            // tlock-js reaches `require("crypto")` only when there is no `window` (its file-key RNG).
            rolldownOptions: { external: ['crypto'] },
          },
        },
      },
    },
  };
});
