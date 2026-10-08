// Shared helpers for not-yet-implemented Durable Object stubs (plan P2.4). Each method rejects with
// a NotImplementedError whose message starts with `not_implemented:` (the part that survives RPC).
import { ERROR_STATUS, errorEnvelope } from '@flocked/shared';
import { NotImplementedError } from '../lib/errors.js';

/** A rejected promise for an RPC method a later session implements. */
export function notImplemented<T>(what: string): Promise<T> {
  return Promise.reject(new NotImplementedError(what));
}

/** A 501 envelope for a stub DO's `fetch` (WebSocket upgrades land there once implemented). */
export function notImplementedResponse(what: string): Response {
  return Response.json(errorEnvelope('not_implemented', `not_implemented: ${what}`), {
    status: ERROR_STATUS.not_implemented,
  });
}
