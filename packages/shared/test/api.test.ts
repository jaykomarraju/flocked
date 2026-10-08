import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as api from '../src/api/index';
import {
  ENDPOINTS,
  ERROR_CODES,
  ERROR_STATUS,
  ROUTE_MODULES,
  errorEnvelope,
} from '../src/api/index';
import type { EndpointDef } from '../src/api/index';
import * as wire from '../src/wire';
import { WsServerMessageSchema } from '../src/ws';

interface InvalidCase {
  why: string;
  value: unknown;
}
interface FixtureFile {
  valid: Record<string, unknown[]>;
  invalid: Record<string, InvalidCase[]>;
}

const FIXTURES = fileURLToPath(new URL('./fixtures/api/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const fixtureFiles = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f, JSON.parse(readFileSync(FIXTURES + f, 'utf8')) as FixtureFile] as const);

const registry: Record<string, unknown> = { ...wire, ...api };

function schemaNamed(name: string): z.ZodType {
  const schema = registry[name];
  if (!(schema instanceof z.ZodType)) throw new Error(`${name} is not an exported schema`);
  return schema;
}

/** parse, then serialize as JSON and read back. */
function roundTrip(schema: z.ZodType, value: unknown): unknown {
  return JSON.parse(JSON.stringify(schema.parse(value)));
}

/** PNG bodies are not JSON; they are tested separately below. */
const BINARY = new Set<z.ZodType>([api.CardImageResponseSchema, api.RoundCardResponseSchema]);

const fixtured = new Set<z.ZodType>(
  fixtureFiles.flatMap(([, data]) => Object.keys(data.valid).map(schemaNamed)),
);

describe('api fixtures', () => {
  for (const [file, data] of fixtureFiles) {
    describe(file, () => {
      for (const [name, values] of Object.entries(data.valid)) {
        it(`${name} accepts and round-trips its valid fixtures`, () => {
          const schema = schemaNamed(name);
          expect(values.length).toBeGreaterThan(0);
          for (const value of values) expect(roundTrip(schema, value)).toEqual(value);
        });
      }
      for (const [name, cases] of Object.entries(data.invalid)) {
        for (const c of cases) {
          it(`${name} rejects: ${c.why}`, () => {
            expect(schemaNamed(name).safeParse(c.value).success).toBe(false);
          });
        }
      }
    });
  }

  it('every exported request, response, query and params schema has a valid fixture', () => {
    const missing = Object.entries(api)
      .filter(
        ([name, value]) =>
          /(Request|Response|Query|Params)Schema$/.test(name) &&
          value instanceof z.ZodType &&
          !fixtured.has(value) &&
          !BINARY.has(value),
      )
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('every schema in ENDPOINTS has a valid fixture (WebSocket messages: test/ws.test.ts)', () => {
    const missing: string[] = [];
    for (const e of ENDPOINTS) {
      for (const schema of [e.request, e.response, e.params, e.query]) {
        if (!schema || schema === WsServerMessageSchema || BINARY.has(schema)) continue;
        if (!fixtured.has(schema)) missing.push(`${e.method} ${e.path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('card images accept PNG bytes only', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(api.CardImageResponseSchema.safeParse(png).success).toBe(true);
    expect(api.RoundCardResponseSchema.safeParse(png).success).toBe(true);
    expect(api.CardImageResponseSchema.safeParse(new Uint8Array([0xff, 0xd8, 0xff])).success).toBe(
      false,
    );
    expect(api.CardImageResponseSchema.safeParse('not bytes').success).toBe(false);
    expect(api.cardVariantOfFile('square.png')).toBe('square');
  });

  it('query schemas coerce numbers from the query string', () => {
    expect(api.RoundsArchiveQuerySchema.parse({ limit: '20' })).toEqual({ limit: 20 });
    expect(api.RoundsArchiveQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(api.RoundsArchiveQuerySchema.safeParse({ limit: 'ten' }).success).toBe(false);
  });
});

describe('wire primitives', () => {
  const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

  it('DecimalBigint is a non-negative decimal string, never a number', () => {
    for (const v of ['0', '7', '5000000', '1'.repeat(78)])
      expect(ok(wire.DecimalBigintSchema, v)).toBe(true);
    for (const v of [0, 5000000, '01', '-1', '1.5', '1e3', ' 1', '', '1'.repeat(79), '0x10']) {
      expect(ok(wire.DecimalBigintSchema, v)).toBe(false);
    }
    expect(ok(wire.SignedDecimalBigintSchema, '-12')).toBe(true);
    expect(ok(wire.SignedDecimalBigintSchema, '-0')).toBe(false);
  });

  it('decimalToBigint and bigintToDecimal are inverse (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 256n - 1n }), (n) => {
        const s = wire.bigintToDecimal(n);
        expect(wire.DecimalBigintSchema.safeParse(s).success).toBe(true);
        expect(wire.decimalToBigint(s)).toBe(n);
      }),
    );
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 128n), max: 2n ** 128n }), (n) => {
        const s = wire.bigintToDecimal(n, { signed: true });
        expect(wire.SignedDecimalBigintSchema.safeParse(s).success).toBe(true);
        expect(wire.decimalToBigint(s)).toBe(n);
      }),
    );
    expect(() => wire.bigintToDecimal(-1n)).toThrow(RangeError);
    expect(() => wire.decimalToBigint('007')).toThrow(RangeError);
  });

  it('UnixSeconds rejects milliseconds and EpochMs rejects seconds', () => {
    expect(ok(wire.UnixSecondsSchema, 1791507600)).toBe(true);
    expect(ok(wire.UnixSecondsSchema, 1791507600000)).toBe(false);
    expect(ok(wire.UnixSecondsSchema, 1791507600.5)).toBe(false);
    expect(ok(wire.EpochMsSchema, 1791507600000)).toBe(true);
    expect(ok(wire.EpochMsSchema, 1791507600)).toBe(false);
    expect(ok(wire.EpochMsSchema, '1791507600000')).toBe(false);
  });

  it('Ulid is 26 uppercase Crockford characters starting 0-7', () => {
    expect(ok(wire.UlidSchema, '01K6Z8Y4N2R7VQ3M5T9W1XB0CD')).toBe(true);
    expect(ok(wire.UlidSchema, '7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(true);
    for (const v of [
      '01k6z8y4n2r7vq3m5t9w1xb0cd',
      '01K6Z8Y4N2R7VQ3M5T9W1XB0CI',
      '01K6Z8Y4N2R7VQ3M5T9W1XB0CL',
      '01K6Z8Y4N2R7VQ3M5T9W1XB0CO',
      '01K6Z8Y4N2R7VQ3M5T9W1XB0CU',
      '81K6Z8Y4N2R7VQ3M5T9W1XB0CD',
      '01K6Z8Y4N2R7VQ3M5T9W1XB0CDD',
    ]) {
      expect(ok(wire.UlidSchema, v)).toBe(false);
    }
  });

  it('Address is lowercase only; hex values are lowercase and sized', () => {
    expect(ok(wire.AddressSchema, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')).toBe(true);
    expect(ok(wire.AddressSchema, '0xAbCdEfabcdefabcdefabcdefabcdefabcdefabcd')).toBe(false);
    expect(ok(wire.AddressSchema, '0xabcdefabcdefabcdefabcdefabcdefabcdefabc')).toBe(false);
    expect(ok(wire.Hex32Schema, '0x' + 'ab'.repeat(32))).toBe(true);
    expect(ok(wire.Hex32Schema, '0x' + 'AB'.repeat(32))).toBe(false);
    expect(ok(wire.HexBytesSchema, '0x')).toBe(true);
    expect(ok(wire.HexBytesSchema, '0xabc')).toBe(false);
    expect(ok(wire.EcdsaSignatureSchema, '0x' + '1b'.repeat(65))).toBe(true);
    expect(ok(wire.EcdsaSignatureSchema, '0x' + '1b'.repeat(64))).toBe(false);
  });

  it('Base64Url is unpadded base64url', () => {
    expect(ok(wire.Base64UrlSchema, 'YWJj')).toBe(true);
    expect(ok(wire.Base64UrlSchema, 'YWI')).toBe(true);
    expect(ok(wire.Base64UrlSchema, '-_8')).toBe(true);
    for (const v of ['YWI=', 'a+b/', 'YWJjZ']) expect(ok(wire.Base64UrlSchema, v)).toBe(false);
  });

  it('GameDay is a real calendar date; IsoWeek is YYYY-Www', () => {
    expect(ok(wire.GameDaySchema, '2026-10-08')).toBe(true);
    expect(ok(wire.GameDaySchema, '2028-02-29')).toBe(true);
    for (const v of ['2026-02-29', '2026-13-01', '2026-10-8', '20261008']) {
      expect(ok(wire.GameDaySchema, v)).toBe(false);
    }
    expect(ok(wire.IsoWeekSchema, '2026-W41')).toBe(true);
    expect(ok(wire.IsoWeekSchema, '2026-W54')).toBe(false);
  });

  it('OptionIndex is 0 or 1', () => {
    expect(ok(wire.OptionIndexSchema, 0)).toBe(true);
    expect(ok(wire.OptionIndexSchema, 1)).toBe(true);
    expect(ok(wire.OptionIndexSchema, 2)).toBe(false);
    expect(ok(wire.OptionIndexSchema, '0')).toBe(false);
  });
});

describe('errors', () => {
  it('codes are unique and each has an HTTP error status', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_STATUS[code]).toBeLessThan(600);
    }
  });

  it('pins the generic codes', () => {
    expect(ERROR_STATUS).toMatchObject({
      bad_request: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      rate_limited: 429,
      internal: 500,
      not_implemented: 501,
    });
  });

  it('errorEnvelope builds a valid envelope', () => {
    const env = errorEnvelope('already_entered', 'You already entered this round.');
    expect(env).toEqual({
      error: { code: 'already_entered', message: 'You already entered this round.' },
    });
    expect(api.ErrorEnvelopeSchema.parse(env)).toEqual(env);
  });
});

/** The spec's path for an ENDPOINTS path: Hono regex constraints back to `:name.png`. */
function specPathOf(e: EndpointDef): string {
  return e.path.replace(/:(\w+)\{[^}]*\\\.png\}/g, ':$1.png');
}

const key = (method: string, path: string) => `${method} ${path}`;

describe('ENDPOINTS', () => {
  it('pins the route modules', () => {
    expect(ROUTE_MODULES).toEqual([
      'auth',
      'me',
      'rounds',
      'entries',
      'stakes',
      'claims',
      'questions',
      'boards',
      'users',
      'rooms',
      'cards',
      'push',
      'limits',
      'admin',
      'paymaster',
    ]);
  });

  it('has unique (method, path) pairs and every module has an endpoint', () => {
    const keys = ENDPOINTS.map((e) => key(e.method, e.path));
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of ROUTE_MODULES)
      expect(
        ENDPOINTS.some((e) => e.module === m),
        m,
      ).toBe(true);
  });

  it('declares a params schema with exactly the path parameters', () => {
    for (const e of ENDPOINTS) {
      const bare = e.path.replace(/\{[^}]*\}/g, '');
      const names = [...bare.matchAll(/:(\w+)/g)].map((m) => m[1]).sort();
      if (names.length === 0) {
        expect(e.params, e.path).toBeUndefined();
        continue;
      }
      expect(e.params, e.path).toBeInstanceOf(z.ZodObject);
      expect(Object.keys((e.params as z.ZodObject).shape).sort(), e.path).toEqual(names);
    }
  });

  it('GETs take no body; responses are never null', () => {
    for (const e of ENDPOINTS) {
      if (e.method === 'GET') expect(e.request, e.path).toBeNull();
      expect(e.response, e.path).toBeInstanceOf(z.ZodType);
    }
  });

  it('serves the WebSocket upgrade with the server message schema', () => {
    const ws = ENDPOINTS.find((e) => e.path === '/rounds/:id/ws');
    expect(ws?.responseType).toBe('websocket');
    expect(ws?.response).toBe(WsServerMessageSchema);
  });
});

// Acceptance: ENDPOINTS matches the spec's API table, row for row ---------------------------------

interface SpecRow {
  method: string;
  path: string;
  auth: string;
}

/** The rows of the API table in Product_Spec.md, read through the spec script. */
function specApiRows(): SpecRow[] {
  const text = execFileSync(process.execPath, ['scripts/spec-section.mjs', 'API'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const rows: SpecRow[] = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim().replace(/\\/g, ''));
    const [, method = '', rawPath = '', auth = ''] = cells;
    if (!/^(GET|POST|PUT|PATCH|DELETE|\*)$/.test(method)) continue;
    rows.push({ method, path: rawPath.replace(/\?.*$/, ''), auth });
  }
  return rows;
}

/** Spec Auth column → allowed `EndpointDef.auth` values (see EndpointDef). */
const AUTH_MAP: Record<string, readonly string[]> = {
  none: ['none', 'optional'],
  user: ['user'],
  admin: ['admin'],
  state: ['none'],
  'user or wallet': ['optional'],
  member: ['user'],
  owner: ['user'],
};

/** In ENDPOINTS but not in the spec's table: pinned by plan wave 10. */
const PLAN_ONLY = new Set(['POST /paymaster']);

describe("ENDPOINTS matches the spec's API table", () => {
  const rows = specApiRows();
  const explicit = rows.filter((r) => r.method !== '*');
  const wildcards = rows.filter((r) => r.method === '*');
  const matchesRow = (e: EndpointDef, r: SpecRow) =>
    e.method === r.method && specPathOf(e) === r.path;
  const underWildcard = (e: EndpointDef) =>
    wildcards.some((w) => e.path.startsWith(w.path.replace(/\*$/, '')));

  it('reads the table', () => {
    expect(explicit.length).toBeGreaterThanOrEqual(43);
    expect(wildcards).toEqual([{ method: '*', path: '/admin/*', auth: 'admin' }]);
  });

  it('has exactly one entry per spec row, with a response schema and a matching auth', () => {
    for (const r of explicit) {
      const hits = ENDPOINTS.filter((e) => matchesRow(e, r));
      expect(hits, key(r.method, r.path)).toHaveLength(1);
      const [hit] = hits;
      expect(hit?.response, key(r.method, r.path)).toBeInstanceOf(z.ZodType);
      expect(AUTH_MAP[r.auth], `unknown spec auth "${r.auth}"`).toBeDefined();
      expect(AUTH_MAP[r.auth], key(r.method, r.path)).toContain(hit?.auth);
    }
  });

  it('has no entry outside the table except the `/admin/*` expansion and plan-pinned routes', () => {
    for (const e of ENDPOINTS) {
      const k = key(e.method, specPathOf(e));
      const hits = explicit.filter((r) => matchesRow(e, r)).length;
      if (PLAN_ONLY.has(k)) {
        expect(hits, k).toBe(0);
        continue;
      }
      expect(hits === 1 || (hits === 0 && underWildcard(e)), k).toBe(true);
    }
  });

  it('expands `* /admin/*` into admin-only endpoints of the admin module', () => {
    const drafted = ENDPOINTS.filter(
      (e) => underWildcard(e) && !explicit.some((r) => matchesRow(e, r)),
    );
    expect(drafted.length).toBeGreaterThan(0);
    for (const e of drafted) {
      expect(e.module, e.path).toBe('admin');
      expect(e.auth, e.path).toBe('admin');
    }
  });

  it('keeps the table order', () => {
    const ordered = ENDPOINTS.filter((e) => explicit.some((r) => matchesRow(e, r))).map((e) =>
      key(e.method, specPathOf(e)),
    );
    expect(ordered).toEqual(explicit.map((r) => key(r.method, r.path)));
  });
});
