// The theme (wave-8.md "Pinned interfaces"): every value comes from @flocked/shared's
// design-tokens.json and reaches components as CSS custom properties and `.type-<role>` classes
// (css.ts). Components never retype a token value.
import type { DesignTokens } from '@flocked/shared';
import raw from '@flocked/shared/design-tokens.json';
import { useSyncExternalStore } from 'react';
import { themeCss } from './css';
import { FONT_FILES } from './fonts';

// design-tokens.json is checked against its schema in CI (packages/shared/test/tokens.test.ts), so
// the bundle carries no zod schema just to read it.
// (JSON imports widen literals such as `version: "1"`, hence the cast.)
export const tokens = raw as DesignTokens;

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const STYLE_ID = 'flocked-theme';

/** Adds the theme's <style> to the document once (fonts, custom properties, type roles). */
export function installTheme(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = themeCss(tokens, FONT_FILES);
  doc.head.prepend(style);
}

/** The layout breakpoint for a viewport width (tokens `breakpoints`: tablet from 768, desktop from 1120). */
export function breakpointFor(width: number): Breakpoint {
  if (width >= tokens.breakpoints.desktop) return 'desktop';
  if (width >= tokens.breakpoints.tablet) return 'tablet';
  return 'mobile';
}

const queries = (): MediaQueryList[] =>
  [tokens.breakpoints.tablet, tokens.breakpoints.desktop].map((w) =>
    window.matchMedia(`(min-width: ${w}px)`),
  );

function subscribe(onChange: () => void): () => void {
  const lists = queries();
  for (const l of lists) l.addEventListener('change', onChange);
  return () => {
    for (const l of lists) l.removeEventListener('change', onChange);
  };
}

function current(): Breakpoint {
  const [tablet, desktop] = queries();
  if (desktop?.matches) return 'desktop';
  if (tablet?.matches) return 'tablet';
  return 'mobile';
}

/** The current layout breakpoint, kept in sync with the viewport. */
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, current, () => 'mobile');
}
