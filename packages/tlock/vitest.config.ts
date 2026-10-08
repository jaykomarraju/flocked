import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.workers.test.ts'],
          testTimeout: 120_000,
        },
      },
      {
        // Runs inside workerd. nodejs_compat is only needed for encryption: tlock-js draws its file key
        // from `require("crypto")` when there is no `window`. Decryption and verification need neither.
        plugins: [
          cloudflareTest({
            miniflare: { compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'] },
          }),
        ],
        test: {
          name: 'workers',
          include: ['test/**/*.workers.test.ts'],
          testTimeout: 120_000,
          // tlock-js ships CommonJS only; workerd's module fallback cannot resolve its nested requires,
          // so Vite pre-bundles it to ESM (wrangler's esbuild does the same for a deployed Worker).
          deps: {
            optimizer: {
              ssr: {
                enabled: true,
                include: [
                  'tlock-js/age/age-encrypt-decrypt.js',
                  'tlock-js/crypto/ibe.js',
                  'tlock-js/drand/timelock-encrypter.js',
                ],
                // tlock-js reaches `require("crypto")` only when there is no `window` (its file-key RNG).
                rolldownOptions: { external: ['crypto'] },
              },
            },
          },
        },
      },
    ],
  },
});
