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
  mode: 'free',
  file: 'manifest.json',
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

/**
 * Endpoints whose owner session has landed; their own tests (test/auth, test/me, ...) cover them,
 * so here they only have to be mounted. Owners add their `METHOD path` rows.
 */
const IMPLEMENTED = new Set([
  // W3-A
  'POST /auth/siwe/nonce',
  'POST /auth/siwe/verify',
  'POST /auth/farcaster',
  'POST /auth/email/start',
  'POST /auth/email/verify',
  'POST /auth/logout',
  'GET /me',
  'PATCH /me',
  'POST /me/tos',
  // W3-B (test/round-do/route.test.ts)
  'POST /rounds/:id/entries',
  // W5-B (test/personhood/)
  'POST /me/personhood',
  'GET /me/personhood/callback',
  // W6-B (test/stakes/)
  'POST /rounds/:id/entries/stakes/prepare',
  // W6-D (test/read/, test/gating/)
  'GET /rounds/today',
  'GET /rounds/:id',
  'GET /rounds',
  'GET /rounds/:id/me',
  'GET /rounds/:id/verify',
  'GET /rounds/:id/bundles/:mode/:file',
  'GET /claims',
  // W7-A (test/ws/)
  'GET /rounds/:id/ws',
  // W7-B (test/identity/, test/limits/, test/me/)
  'POST /me/identities/link',
  'POST /me/merges/:id/confirm',
  'DELETE /me/identities/:id',
  'POST /me/email',
  'POST /me/email/verify',
  'GET /me/referrals',
  'DELETE /me',
  'PUT /me/limits',
  'POST /me/limits/exclusion-lift',
  // W8-A (test/questions/)
  'GET /questions',
  'POST /questions',
  'POST /questions/:id/vote',
  // W8-B (test/boards/, test/stats/, test/referrals/)
  'GET /leaderboards/:board',
  'GET /users/:handle',
  // W8-D (test/rooms/)
  'POST /rooms',
  'POST /rooms/join',
  'GET /rooms/:id',
  'POST /rooms/:id/questions',
  // W9-A (test/notify/)
  'POST /push/subscribe',
]);

/**
 * Stubs behind the room-round gate (W6-D, src/read/access.ts): an unknown round answers 404 before
 * the stub's 501 (test/gating/ checks the 501 for a public round and the gate for room rounds).
 */
const GATED_STUBS = new Set([
  `GET ${ENDPOINTS.find((e) => e.path.startsWith('/rounds/:id/card/'))?.path ?? ''}`,
]);

const label = (ep: EndpointDef) => `${ep.method} ${ep.path}`;

describe.each(
  ENDPOINTS.filter((ep) => IMPLEMENTED.has(label(ep))).map((ep) => [label(ep), ep] as const),
)('%s (implemented)', (_label, ep) => {
  it('is mounted: answers through the Worker, not 404', async () => {
    const res = await exports.default.fetch(requestFor(ep));
    expect(res.status).not.toBe(501);
    if (res.status === 404) {
      // A round read answers 404 for a round that does not exist, and a profile for an unknown
      // handle: from its handler, not the router.
      const message = ErrorEnvelopeSchema.parse(await res.json()).error.message;
      if (ep.path === '/users/:handle') expect(message).toBe('No such user');
      else {
        expect(ep.path.startsWith('/rounds/:id')).toBe(true);
        expect(message).toBe('No such round');
      }
    }
  });
});

describe.each(
  ENDPOINTS.filter((ep) => GATED_STUBS.has(label(ep))).map((ep) => [label(ep), ep] as const),
)('%s (gated stub)', (_label, ep) => {
  it('answers 404 not_found for a round that does not exist, before the stub', async () => {
    const res = await exports.default.fetch(requestFor(ep));
    expect(res.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(await res.json()).error.code).toBe('not_found');
  });
});

describe.each(
  ENDPOINTS.filter((ep) => !IMPLEMENTED.has(label(ep)) && !GATED_STUBS.has(label(ep))).map(
    (ep) => [label(ep), ep] as const,
  ),
)('%s', (_label, ep) => {
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
});

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
