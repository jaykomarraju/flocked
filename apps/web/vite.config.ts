// Vite builds the SPA into dist/, which the API Worker serves (apps/api/wrangler.jsonc `assets`).
// `--mode e2e` (build:e2e) also builds the design sheets under /__sheets, which the Playwright `ui`
// project compares with the Paper exports; production builds leave them out.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
