// Playwright over the local stack (W7-D; plan 4.2). Start it first: `pnpm stack:up`, then `pnpm e2e`
// (or `pnpm e2e:ui`, on a fresh stack of its own).
//
// Projects (wave-7.md and wave-8.md "Pinned interfaces"):
//   api       API-level lifecycle specs, e2e/tests/*.spec.ts (W7-D). Vitest keeps tests/*.test.ts.
//   api-warp  the same files' tests tagged @warp, after `api`: the steps that move anvil's clock.
//   ui        browser specs, e2e/ui/*.spec.ts (W8-C): screenshots of the web app against the Paper
//             exports (tagged @screenshot), axe, and sign-in end to end. The app is the stack's own (the
//             API Worker serves apps/web/dist at APP_ORIGIN), so build it first: `pnpm e2e:ui` does.
//   ui-warp   the ui specs' tests tagged @warp, after `ui` (none yet).
//
// The two-phase rule (W7-D; W7-Z review): anvil's clock only moves forward, and the escrow refuses
// `createRound` once its clock has passed opensAt, so no new round can be made after a warp. Every
// round a spec warps past (the 2 h challenge window, the 72 h refund timeout) is therefore created,
// entered and proposed in a non-warp phase, and its @warp tests run in that suite's warp phase once
// all of them exist, each moving the chain and game clocks to at least its own target
// (fixtures/clock.ts `warpTo`). A spec's first phase hands its round to its warp phase through
// fixtures/phase.ts.
//
// The api suite and the ui suite each run on a fresh stack of their own (`pnpm e2e`: api, api-warp;
// `pnpm e2e:ui`: ui, ui-warp), so each warp phase runs after the one non-warp phase sharing its stack.
// The first warp writes `.run/e2e/warped.json`, and the `stack` fixture then refuses any non-warp
// phase on that stack (fixtures/index.ts). ui/phases.test.ts checks that every test lands in exactly
// one phase.
//
// One worker: every spec shares the stack's anvil, keys, drand network and game clock.
import { defineConfig, devices } from '@playwright/test';
import { readState } from './stack/env.mjs';

const state = readState() as { appOrigin?: string } | null;

/**
 * `UI_PREVIEW=1` (`pnpm e2e:screens`) serves apps/web/dist with `vite preview` instead of the stack:
 * enough for the @screenshot tests, which need no API. CI runs them on macOS, where text renders as in
 * the exports (Paper draws with Chromium on a Mac; Linux's FreeType differs by 1.5-2.4% of pixels).
 */
const preview = process.env.UI_PREVIEW === '1';
const PREVIEW_URL = 'http://localhost:4173';

/** The web app under test: the stack's APP_ORIGIN (SIWE checks the domain), or UI_BASE_URL. */
const uiBaseUrl =
  process.env.UI_BASE_URL ??
  (preview ? PREVIEW_URL : (state?.appOrigin ?? 'http://localhost:8787'));

const ui = {
  testDir: './ui',
  testMatch: '*.spec.ts',
  // Baselines are the design exports, written only by a design session (docs/design/README.md).
  snapshotPathTemplate: '../docs/design/exports/{arg}{ext}',
  updateSnapshots: 'none' as const,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: uiBaseUrl,
    // The exports are 2x renders by Paper (Electron, so Chromium) on a Display P3 Mac. An emulated
    // deviceScaleFactor alone thins 1.5px borders to 1px, so the device scale is forced at launch too,
    // and the colour profile matches the exports' (W8-C measured both).
    deviceScaleFactor: 2,
    launchOptions: {
      args: ['--force-device-scale-factor=2', '--force-color-profile=display-p3-d65'],
    },
    colorScheme: 'light' as const,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },
};

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // A Stakes round waits for its beacon, the safe head and the proposal (about 4 minutes).
  timeout: 10 * 60_000,
  // Under each e2e.yml job's 45 minutes, so a stuck run still ends and writes its report.
  globalTimeout: 40 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]],
  outputDir: '../test-results',
  webServer: preview
    ? {
        command: 'pnpm --filter @flocked/web exec vite preview --port 4173 --strictPort',
        url: PREVIEW_URL,
        reuseExistingServer: !process.env.CI,
      }
    : undefined,
  projects: [
    { name: 'api', grepInvert: /@warp/ },
    { name: 'api-warp', grep: /@warp/, dependencies: ['api'] },
    { name: 'ui', ...ui, grepInvert: /@warp/ },
    { name: 'ui-warp', ...ui, grep: /@warp/, dependencies: ['ui'] },
  ],
});
