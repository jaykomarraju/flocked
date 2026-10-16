// A design sheet: a page that lays out real components exactly as one Paper artboard does, so the
// Playwright `ui` project can compare it with that artboard's export (e2e/fixtures/screenshot.ts).
// Sheets are built only in `--mode e2e` and dev (routes.tsx), never in production.
import type { ReactNode } from 'react';

export type SheetTheme = 'light' | 'dark';
export type SheetBreakpoint = 'mobile' | 'tablet' | 'desktop';

export interface SheetDef {
  /** `<surface>/<screen>`, as in the artboard name `<surface>/<screen>/<state>/<breakpoint>`. */
  name: string;
  /** The artboards this sheet draws: `<state>/<breakpoint>` (e.g. `light/desktop`, `card-1/mobile`). */
  artboards: string[];
  /** Renders one artboard. */
  render: (state: string, breakpoint: SheetBreakpoint) => ReactNode;
}
