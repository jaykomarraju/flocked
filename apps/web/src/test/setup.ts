// Vitest + Testing Library setup (jsdom): jest-dom matchers, cleanup, the theme, matchMedia.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { installTheme } from '../theme';

// jsdom has no matchMedia: answer every query as false (the mobile breakpoint, light, motion on).
if (!window.matchMedia) {
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

installTheme();

afterEach(() => {
  cleanup();
});
