import type { BundleSource } from './types.js';

/**
 * Where bundle objects live over HTTP:
 * - `api` (default): the Flocked API's public route `GET {base}/rounds/:id/bundles/:mode/:file`
 *   (pinned since W6-Z; served once the mode is revealed);
 * - `bucket`: a mirror of the bucket, `{base}/bundles/{roundId}/{mode}/{file}`.
 */
export type HttpLayout = 'api' | 'bucket';

export function bundleUrl(baseUrl: string, key: string, layout: HttpLayout = 'api'): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (layout === 'bucket') return `${base}/${key}`;
  const m = /^bundles\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(key);
  if (!m) throw new Error(`not a bundle key: ${key}`);
  return `${base}/rounds/${m[1]}/bundles/${m[2]}/${m[3]}`;
}

/** Reads bundle objects over HTTP. A 404 is an absent object; any other failure throws. */
export function httpSource(
  baseUrl: string,
  o: { layout?: HttpLayout; fetch?: typeof fetch } = {},
): BundleSource {
  const get = o.fetch ?? fetch;
  return async (key) => {
    const url = bundleUrl(baseUrl, key, o.layout);
    const res = await get(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** Serves bundle objects from memory, by key (tests, and bundles a caller already holds). */
export function memorySource(objects: ReadonlyMap<string, Uint8Array>): BundleSource {
  return (key) => Promise.resolve(objects.get(key) ?? null);
}
