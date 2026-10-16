// `@flocked/verify/browser` must build for the browser without Node APIs (wave-9 "W9-B"): esbuild
// bundles it for the browser platform, where any Node built-in fails to resolve.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../src/browser.ts', import.meta.url));

describe('browser subset', () => {
  it('bundles for the browser with no Node built-ins', async () => {
    const r = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    expect(r.errors).toEqual([]);
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.some((p) => p.endsWith('src/verify.ts'))).toBe(true);
    expect(inputs.filter((p) => /^node:|src\/(node|cli)\.ts$/.test(p))).toEqual([]);
    const imports = Object.values(r.metafile.inputs).flatMap((i) => i.imports.map((x) => x.path));
    expect(imports.filter((p) => p.startsWith('node:'))).toEqual([]);
  });
});
