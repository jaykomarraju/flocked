// Opaque list cursors (`CursorSchema`, at most 256 characters): the sort key of the last row served,
// as unpadded base64url of a JSON array. Keyset pagination: the next page is the rows strictly after
// that key, so rows inserted meanwhile never shift a page. A cursor that doesn't decode to the
// expected key is 400 `bad_request`.
import { CursorSchema } from '@flocked/shared';
import type { z } from 'zod';
import { HttpError } from '../lib/errors.js';

/** Encodes a keyset (numbers and ASCII strings, such as epoch ms and ULIDs). */
export function encodeCursor(key: readonly (string | number)[]): string {
  const b64 = btoa(JSON.stringify(key));
  return CursorSchema.parse(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

/** Decodes a cursor into the keyset `schema` describes, or throws 400 `bad_request`. */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    raw = undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError('bad_request', 'Invalid cursor');
  return parsed.data;
}
