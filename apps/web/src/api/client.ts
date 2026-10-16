// The typed API client (wave-8.md "Pinned interfaces": over packages/shared/src/api). Every call
// names an endpoint from ENDPOINTS by method and path, with the same request and response schemas
// (checked when the endpoint is declared, and for every declared endpoint in client.test.ts), and
// validates the answer against the response schema. Sessions ride on the HttpOnly cookie in the
// browser (same origin) or on a Bearer token in the mini app (`getToken`); a 401 that means the
// session is gone calls `onSessionLost`, so the auth state drops it.
import {
  API_BASE_PATH,
  ENDPOINTS,
  EmailStartRequestSchema,
  EmailStartResponseSchema,
  EmailVerifyRequestSchema,
  EmailVerifyResponseSchema,
  ErrorEnvelopeSchema,
  FarcasterAuthRequestSchema,
  FarcasterAuthResponseSchema,
  LogoutResponseSchema,
  MeResponseSchema,
  RoundsTodayResponseSchema,
  SiweNonceResponseSchema,
  SiweVerifyRequestSchema,
  SiweVerifyResponseSchema,
  type EndpointDef,
  type ErrorCode,
} from '@flocked/shared';
import type { z } from 'zod';

/** An endpoint the client calls: its ENDPOINTS row, typed by its schemas. */
export interface Endpoint<Req extends z.ZodType | null, Res extends z.ZodType> {
  method: EndpointDef['method'];
  path: string;
  request: Req;
  response: Res;
}

/** Declares an endpoint; throws unless ENDPOINTS has it with these exact schemas. */
export function endpoint<Req extends z.ZodType | null, Res extends z.ZodType>(
  method: EndpointDef['method'],
  path: string,
  request: Req,
  response: Res,
): Endpoint<Req, Res> {
  const def = ENDPOINTS.find((e) => e.method === method && e.path === path);
  if (!def) throw new Error(`${method} ${path} is not in ENDPOINTS`);
  if (def.request !== request || def.response !== response) {
    throw new Error(`${method} ${path}: schemas differ from ENDPOINTS`);
  }
  return { method, path, request, response };
}

/** The endpoints the web app calls so far. Later screens add theirs here. */
export const api = {
  siweNonce: endpoint('POST', '/auth/siwe/nonce', null, SiweNonceResponseSchema),
  siweVerify: endpoint(
    'POST',
    '/auth/siwe/verify',
    SiweVerifyRequestSchema,
    SiweVerifyResponseSchema,
  ),
  farcaster: endpoint(
    'POST',
    '/auth/farcaster',
    FarcasterAuthRequestSchema,
    FarcasterAuthResponseSchema,
  ),
  emailStart: endpoint(
    'POST',
    '/auth/email/start',
    EmailStartRequestSchema,
    EmailStartResponseSchema,
  ),
  emailVerify: endpoint(
    'POST',
    '/auth/email/verify',
    EmailVerifyRequestSchema,
    EmailVerifyResponseSchema,
  ),
  logout: endpoint('POST', '/auth/logout', null, LogoutResponseSchema),
  me: endpoint('GET', '/me', null, MeResponseSchema),
  roundsToday: endpoint('GET', '/rounds/today', null, RoundsTodayResponseSchema),
};

/**
 * A failed call. `code` is the API's error code; `network` when no answer arrived (offline, or the
 * connection dropped); `bad_response` when the answer didn't match the schema.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network' | 'bad_response',
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** A 4xx the user can act on (the known-cause error box), as opposed to a fault or no answer. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/** 401 codes that mean the session itself is gone (not a failed sign-in attempt). */
const SESSION_LOST: readonly string[] = ['unauthorized', 'session_expired'];

export interface CallInput<Req extends z.ZodType | null> {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: Req extends z.ZodType ? z.input<Req> : never;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** Origin of the API; the page's own origin by default (the API Worker serves the app). */
  origin?: string;
  fetch?: typeof fetch;
  /** The mini app's Bearer token, when it has one. */
  getToken?: () => string | null;
  /** Called when a 401 says the session is gone. */
  onSessionLost?: () => void;
}

export interface ApiClient {
  call<Req extends z.ZodType | null, Res extends z.ZodType>(
    e: Endpoint<Req, Res>,
    input?: CallInput<Req>,
  ): Promise<z.infer<Res>>;
}

/** `/rounds/:id` with `{ id }` → `/rounds/01J…` (each value URL-encoded). */
export function fillPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${path}: missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  return {
    async call(e, input = {}) {
      const url = new URL(
        `${API_BASE_PATH}${fillPath(e.path, input.params)}`,
        opts.origin ?? window.location.origin,
      );
      for (const [k, v] of Object.entries(input.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      const token = opts.getToken?.() ?? null;
      const headers: Record<string, string> = { accept: 'application/json' };
      if (input.body !== undefined) headers['content-type'] = 'application/json';
      if (token) headers.authorization = `Bearer ${token}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: e.method,
          headers,
          credentials: 'same-origin',
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal: input.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        throw new ApiError(0, 'network', 'No answer from Flocked');
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        throw new ApiError(res.status, 'bad_response', `${e.method} ${e.path}: not JSON`);
      }
      if (!res.ok) {
        const envelope = ErrorEnvelopeSchema.safeParse(json);
        const code = envelope.success
          ? envelope.data.error.code
          : res.status >= 500
            ? 'internal'
            : 'bad_request';
        const message = envelope.success ? envelope.data.error.message : `HTTP ${res.status}`;
        if (res.status === 401 && SESSION_LOST.includes(code)) opts.onSessionLost?.();
        throw new ApiError(res.status, code, message);
      }
      const parsed = e.response.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(res.status, 'bad_response', `${e.method} ${e.path}: unexpected answer`);
      }
      return parsed.data;
    },
  };
}
