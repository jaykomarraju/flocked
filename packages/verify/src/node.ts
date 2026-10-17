// Node-only helpers for the CLI. The browser subset (`@flocked/verify/browser`) never imports this.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleSource } from './types.js';

/** Reads bundle objects from a directory that mirrors the bucket: `${dir}/bundles/{roundId}/{mode}/…`. */
export function dirSource(dir: string): BundleSource {
  return async (key) => {
    try {
      return new Uint8Array(await readFile(join(dir, ...key.split('/'))));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };
}
