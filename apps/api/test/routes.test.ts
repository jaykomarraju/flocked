// Route skeleton: every endpoint in the pinned ENDPOINTS table is mounted (answers 501
// `not_implemented` in the error envelope, never 404), and unknown paths answer 404 in the envelope.
// Requests go through the Worker's real `fetch` export.
import { exports } from 'cloudflare:workers';
import {
  API_BASE_PATH,
  ENDPOINTS,
  ErrorEnvelopeSchema,
  ROUTE_MODULES,
  type EndpointDef,
} from '@flocked/shared';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { ROUTE_APPS } from '../src/routes/index.js';
import { endpointsOf } from '../src/routes/stub.js';
import { FIXTURE_IDS, fakeUser, withSession } from './helpers/index.js';

const ORIGIN = 'https://flocked.test';

/** Sample values for path parameters, by name. */
const SAMPLE_PARAMS: Record<string, string> = {
  id: FIXTURE_IDS.round,
  shareId: 'Sh4reId_01',
  variant: 'og.png',
  handle: 'ewe_one',
  board: 'strays',
  gameDay: '2026-10-08',
};

/** Fills `:name` and `:name{regex}` segments with SAMPLE_PARAMS. */
function concretePath(path: string): string {
  return path.replace(/:([A-Za-z_]+)(\{[^/]*\})?/g, (_m, name: string) => {
    const v = SAMPLE_PARAMS[name];
    if (v === undefined) throw new Error(`no sample for :${name} in ${path}`);
    return v;
  });
}

function requestFor(ep: EndpointDef, path = concretePath(ep.path)): Request {
  const hasBody = ep.method !== 'GET' && ep.method !== 'DELETE';
  return new Request(`${ORIGIN}${API_BASE_PATH}${path}`, {
    method: ep.method,
    headers: hasBody ? { 'content-type': 'application/json' } : {},
    body: hasBody ? '{}' : undefined,
  });
}

describe('route modules', () => {
  it('mounts one sub-app per pinned module', () => {
    expect(Object.keys(ROUTE_APPS).sort()).toEqual([...ROUTE_MODULES].sort());
  });

  it('every endpoint belongs to a module', () => {
    const total = ROUTE_MODULES.reduce((n, m) => n + endpointsOf(m).length, 0);
    expect(total).toBe(ENDPOINTS.length);
    expect(ENDPOINTS.length).toBeGreaterThan(40);
  });
});

describe.each(ENDPOINTS.map((ep) => [`${ep.method} ${ep.path}`, ep] as const))(
  '%s',
  (_label, ep) => {
    it('answers 501 not_implemented through the Worker', async () => {
      const res = await exports.default.fetch(requestFor(ep));
      expect(res.status).toBe(501);
      const body = ErrorEnvelopeSchema.parse(await res.json());
      expect(body.error.code).toBe('not_implemented');
      expect(body.error.message).toContain(ep.path);
    });

    it('answers 501 with a signed-in user too', async () => {
      const res = await withSession(app, fakeUser({ role: 'admin' })).request(requestFor(ep));
      expect(res.status).toBe(501);
    });
  },
);

describe('unknown routes', () => {
  it.each([
    ['GET', '/nope'],
    ['GET', '/rounds/x/y/z'],
    ['POST', '/me/unknown'],
    ['DELETE', '/rounds/today'],
  ])('%s %s answers 404 not_found in the envelope', async (method, path) => {
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}${API_BASE_PATH}${path}`, { method }),
    );
    expect(res.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(await res.json()).error.code).toBe('not_found');
  });

  it('a card variant outside og/embed/square is not a route', async () => {
    const res = await exports.default.fetch(
      new Request(`${ORIGIN}${API_BASE_PATH}/cards/Sh4reId_01/huge.png`),
    );
    expect(res.status).toBe(404);
  });

  it('paths outside the API base answer 404 in the envelope from the app', async () => {
    const res = await app.request('/v2/rounds/today');
    expect(res.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(await res.json()).error.code).toBe('not_found');
  });
});
