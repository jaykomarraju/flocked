// Vitest + Testing Library setup (jsdom): jest-dom matchers, cleanup, the theme, matchMedia. A test
// file that runs in Node (`// @vitest-environment node`, e.g. the tlock crypto tests, whose noble
// checks fail on jsdom's Uint8Array realm) skips the DOM parts.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { installTheme } from '../theme';

const dom = typeof window !== 'undefined';

// jsdom has no matchMedia: answer every query as false (the mobile breakpoint, light, motion on).
if (dom && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (dom) installTheme();

afterEach(() => {
  if (dom) cleanup();
});
