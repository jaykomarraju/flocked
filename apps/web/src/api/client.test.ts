import { ENDPOINTS, MeResponseSchema, SiweNonceResponseSchema } from '@flocked/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, createApiClient, endpoint, fillPath } from './client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const NONCE = { nonce: 'abcdef0123456789abcdef0123456789', expiresAt: 1_760_000_000_000 };

describe('endpoints', () => {
  it('declares only ENDPOINTS rows, with their schemas', () => {
    for (const e of Object.values(api)) {
      const row = ENDPOINTS.find((r) => r.method === e.method && r.path === e.path);
      expect(row?.request).toBe(e.request);
      expect(row?.response).toBe(e.response);
    }
  });

  it('refuses an endpoint that is not in ENDPOINTS or has other schemas', () => {
    expect(() => endpoint('GET', '/nope', null, MeResponseSchema)).toThrow(/not in ENDPOINTS/);
    expect(() => endpoint('GET', '/me', null, SiweNonceResponseSchema)).toThrow(/schemas differ/);
  });

  it('fills path parameters, encoded', () => {
    expect(
      fillPath('/rounds/:id/bundles/:mode/:file', { id: 'R1', mode: 'free', file: 'a b' }),
    ).toBe('/rounds/R1/bundles/free/a%20b');
    expect(() => fillPath('/rounds/:id')).toThrow(/missing path parameter id/);
  });
});

describe('createApiClient', () => {
  it('calls under /api/v1 with the Bearer token and query, and validates the answer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, NONCE));
    const client = createApiClient({ origin: 'http://app.test', fetch, getToken: () => 'tok' });
    await expect(client.call(api.siweNonce, { query: { a: 1, b: undefined } })).resolves.toEqual(
      NONCE,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect((url as URL).href).toBe('http://app.test/api/v1/auth/siwe/nonce?a=1');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(init?.credentials).toBe('same-origin');
  });

  it('sends a JSON body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, { ok: true }));
    const client = createApiClient({ origin: 'http://app.test', fetch });
    await client.call(api.emailStart, { body: { email: 'a@b.co' } });
    const init = fetch.mock.calls[0]![1];
    expect(init?.body).toBe('{"email":"a@b.co"}');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('turns the error envelope into an ApiError with its code', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(401, { error: { code: 'invalid_code', message: 'No valid code' } }));
    const onSessionLost = vi.fn();
    const client = createApiClient({ origin: 'http://app.test', fetch, onSessionLost });
    const err = await client
      .call(api.emailVerify, { body: { email: 'a@b.co', code: '12345678' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'invalid_code', message: 'No valid code' });
    expect((err as ApiError).isClientError).toBe(true);
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('drops the session on a 401 that says it is gone', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(401, { error: { code: 'session_expired', message: 'Expired' } }));
    const onSessionLost = vi.fn();
    const client = createApiClient({ origin: 'http://app.test', fetch, onSessionLost });
    await expect(client.call(api.me)).rejects.toMatchObject({ code: 'session_expired' });
    expect(onSessionLost).toHaveBeenCalledOnce();
  });

  it('reports no answer as a network error, and a wrong shape as bad_response', async () => {
    const offline = createApiClient({
      origin: 'http://app.test',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(offline.call(api.me)).rejects.toMatchObject({ status: 0, code: 'network' });
    const odd = createApiClient({
      origin: 'http://app.test',
      fetch: () => Promise.resolve(json(200, { nonce: 1 })),
    });
    await expect(odd.call(api.siweNonce)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('names a 5xx without an envelope as internal', async () => {
    const client = createApiClient({
      origin: 'http://app.test',
      fetch: () => Promise.resolve(json(502, { message: 'upstream' })),
    });
    await expect(client.call(api.me)).rejects.toMatchObject({ status: 502, code: 'internal' });
  });
});
