// Error envelope for every API response: `{error: {code, message}}` (spec "API"). Route code throws
// `HttpError`; `onError` and `notFound` turn anything into the envelope with the code's status.
import { ERROR_STATUS, errorEnvelope, type ErrorCode } from '@flocked/shared';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { log } from './log.js';

export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly status: ContentfulStatusCode;

  constructor(
    readonly code: ErrorCode,
    message: string,
    status?: ContentfulStatusCode,
  ) {
    super(message);
    this.status = status ?? (ERROR_STATUS[code] as ContentfulStatusCode);
  }
}

/** Prefix of every not-implemented error message, so callers across RPC can recognise it. */
export const NOT_IMPLEMENTED = 'not_implemented';

/**
 * Thrown by stubs (route handlers, DO methods) that a later session implements. Over DO RPC only the
 * message survives, so it always starts with `not_implemented:`.
 */
export class NotImplementedError extends HttpError {
  constructor(what: string) {
    super('not_implemented', `${NOT_IMPLEMENTED}: ${what}`);
  }
}

/** True for an error (local or received over RPC) raised by a not-implemented stub. */
export function isNotImplemented(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(`${NOT_IMPLEMENTED}:`);
}

/** JSON envelope response. */
export function errorResponse(
  c: Context,
  code: ErrorCode,
  message: string,
  status?: ContentfulStatusCode,
): Response {
  return c.json(
    errorEnvelope(code, message),
    status ?? (ERROR_STATUS[code] as ContentfulStatusCode),
  );
}

/** Generic code for a bare HTTP status (Hono's own HTTPException, e.g. malformed JSON → 400). */
const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'rate_limited',
  503: 'unavailable',
};

/**
 * Hono `onError`: HttpError keeps its code; Hono's HTTPException maps by status; anything else is
 * logged and becomes `internal`.
 */
export const onError: ErrorHandler = (err, c) => {
  if (err instanceof HttpError) return errorResponse(c, err.code, err.message, err.status);
  if (err instanceof HTTPException) {
    const code = STATUS_CODES[err.status];
    if (code) return errorResponse(c, code, err.message || code, err.status);
  }
  log.error('unhandled_error', {
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
  });
  return errorResponse(c, 'internal', 'Internal error');
};

/** Hono `notFound`: 404 in the envelope (not Hono's plain-text default). */
export const notFound: NotFoundHandler = (c) => errorResponse(c, 'not_found', 'Not found');
