// The screenshot helper (W8-C; wave-8.md "Screenshot tests"). A `ui` spec names a Paper artboard
// (`<surface>/<screen>/<state>/<breakpoint>`, docs/design/README.md "Artboard names"); the helper opens
// the web app's design sheet for it (/__sheets/..., built by `build:e2e`), sizes the viewport to the
// artboard (the export is 2x, as the `ui` project's deviceScaleFactor), waits for the sheet and its
// self-hosted fonts, and compares a screenshot with the export
// `docs/design/exports/<surface>/<screen>__<state>__<breakpoint>.png` (playwright.config.ts
// `snapshotPathTemplate`; never updated by a test run) at the pinned tolerance.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

/** The pinned tolerance: at most 1% of pixels may differ (wave-8.md "Pinned interfaces"). */
export const MAX_DIFF_PIXEL_RATIO = 0.01;

const EXPORTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'design',
  'exports',
);

/** The export's path segments under docs/design/exports for an artboard name. */
export function exportPath(artboard: string): [string, string] {
  const parts = artboard.split('/');
  if (parts.length !== 4 || parts.some((p) => !/^[a-z0-9-]+$/.test(p))) {
    throw new Error(`not an artboard name: ${artboard}`);
  }
  const [surface, screen, state, breakpoint] = parts as [string, string, string, string];
  return [surface, `${screen}__${state}__${breakpoint}.png`];
}

/** Width and height (px) of a PNG, from its IHDR chunk. */
export function pngSize(file: string): { width: number; height: number } {
  const head = readFileSync(file).subarray(0, 24);
  if (head.toString('latin1', 12, 16) !== 'IHDR') throw new Error(`${file} is not a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** The artboard's size in CSS pixels: its 2x export halved. */
export function artboardSize(artboard: string): { width: number; height: number } {
  const { width, height } = pngSize(join(EXPORTS_DIR, ...exportPath(artboard)));
  return { width: width / 2, height: height / 2 };
}

/**
 * Opens the artboard's design sheet at the artboard's size and expects it to match the export.
 * `path` opens another page instead (an app route drawn at the artboard's size).
 */
export async function expectArtboard(
  page: Page,
  artboard: string,
  opts: { path?: string } = {},
): Promise<void> {
  await page.setViewportSize(artboardSize(artboard));
  await page.goto(opts.path ?? `/__sheets/${artboard}`);
  await page.locator('[data-sheet-ready="true"]').waitFor();
  // (A string: e2e's tsconfig has no DOM lib.)
  await page.waitForFunction('document.fonts.status === "loaded"');
  await expect(page).toHaveScreenshot(exportPath(artboard), {
    animations: 'disabled',
    caret: 'hide',
    scale: 'device',
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
  });
}
