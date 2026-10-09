// e2e tests run in Node against the local stack (`pnpm stack:up`); they are not part of `pnpm test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // A round has to close and its beacon arrive (beaconDelay 60 s on a 3 s chain).
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
