// NFR-7 (signer isolation), the API's half: apps/api has no access to TICKET_SIGNER_KEY. It is not
// a binding or var of this Worker in any environment, `Env` has no such field, and no source file
// reads it or imports the signer's code; tickets are signed only through the `SIGNER` service
// binding. apps/signer/test/isolation.test.ts checks that the signer holds that key and no other.
import { env } from 'cloudflare:test';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Env } from '../../src/env.js';
import type { StakesEnv } from '../../src/stakes/signer.js';
import type { WranglerSummary } from '../env.js';

declare global {
  /** Vite's `import.meta.glob`, resolved at transform time. */
  interface ImportMeta {
    glob: (
      pattern: string,
      opts: { query: '?raw'; import: 'default'; eager: true },
    ) => Record<string, unknown>;
  }
}

/** apps/api's source files, as text (Vite's raw glob). */
const SOURCES = import.meta.glob('../../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('NFR-7: apps/api has no access to TICKET_SIGNER_KEY', () => {
  it('is not in the test bindings (wrangler.jsonc plus any .dev.vars)', () => {
    expect(Object.keys(env)).not.toContain('TICKET_SIGNER_KEY');
  });

  it('is not a var in any wrangler environment', () => {
    const summary = JSON.parse(env.TEST_WRANGLER) as WranglerSummary;
    for (const [name, c] of Object.entries(summary)) {
      expect(Object.keys(c.vars), name).not.toContain('TICKET_SIGNER_KEY');
    }
  });

  it('is not a field of Env, nor of the Stakes env with the SIGNER binding', () => {
    expectTypeOf<Env>().not.toHaveProperty('TICKET_SIGNER_KEY');
    expectTypeOf<StakesEnv>().not.toHaveProperty('TICKET_SIGNER_KEY');
    expectTypeOf<StakesEnv>().toHaveProperty('SIGNER');
  });

  it('no source file reads it or imports the signer', () => {
    const files = Object.entries(SOURCES);
    expect(files.length).toBeGreaterThan(50);
    for (const [path, text] of files) {
      const src = String(text);
      expect(src, path).not.toMatch(/\.TICKET_SIGNER_KEY\b|['"`]TICKET_SIGNER_KEY['"`]/);
      expect(src, path).not.toMatch(
        /(?:from|import\()\s*['"][^'"]*(?:apps\/signer|@flocked\/signer)/,
      );
    }
  });
});
