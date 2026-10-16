// Vite builds the SPA into dist/, which the API Worker serves (apps/api/wrangler.jsonc `assets`).
// `--mode e2e` (build:e2e) also builds the design sheets under /__sheets, which the Playwright `ui`
// project compares with the Paper exports; production builds leave them out.
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/** Settings a production build can't do without (src/auth/config.ts reads them; no fallback). */
const REQUIRED_IN_PRODUCTION = ['VITE_CHAIN_ID', 'VITE_TURNSTILE_SITE_KEY'];

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'production') {
    const env = loadEnv(mode, process.cwd());
    const missing = REQUIRED_IN_PRODUCTION.filter((k) => !env[k]);
    if (missing.length) throw new Error(`A production build needs ${missing.join(' and ')}`);
  }
  return {
    plugins: [react()],
    build: { target: 'es2022', sourcemap: true },
    server: { port: 5173, strictPort: true },
    test: {
      environment: 'jsdom',
      setupFiles: ['src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
    },
  };
});
