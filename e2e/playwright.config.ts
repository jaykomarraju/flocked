// Playwright over the local stack (W7-D; plan 4.2). Start it first: `pnpm stack:up`, then `pnpm e2e`.
//
// Projects (wave-7.md "Pinned interfaces"):
//   api       API-level lifecycle specs, e2e/tests/*.spec.ts (W7-D). Vitest keeps tests/*.test.ts.
//   api-warp  the same files' tests tagged @warp, after `api`: the steps that move anvil's clock.
//   ui        browser specs in e2e/ui/ (W8-C on; none yet).
//
// Why two api phases: anvil's clock only moves forward, and the escrow refuses `createRound` once
// its clock has passed opensAt, so no new round can be made after a warp. Every round a spec warps
// past (the 2 h challenge window, the 72 h refund timeout) is therefore created, entered and proposed
// in `api`, and its @warp tests run in `api-warp` once all of them exist, each moving the chain and
// game clocks to at least its own target (fixtures/clock.ts `warpTo`). A spec's `api` phase hands
// its round to its `api-warp` phase through fixtures/phase.ts.
//
// One worker: every spec shares the stack's anvil, keys, drand network and game clock.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // A Stakes round waits for its beacon, the safe head and the proposal (about 4 minutes).
  timeout: 10 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]],
  outputDir: '../test-results',
  projects: [
    { name: 'api', grepInvert: /@warp/ },
    { name: 'api-warp', grep: /@warp/, dependencies: ['api'] },
    { name: 'ui', testDir: './ui', testMatch: '*.spec.ts' },
  ],
});
