// Reserved handles (spec "API": `PATCH /me` refuses reserved handles, a short case-insensitive
// blocklist kept in packages/shared). A handle is reserved when it equals an entry once case and the
// separators `_` and `-` are ignored, so "Ad_Min" and "flocked-" are reserved too.

/** The blocklist, in normal form (lowercase, no `_` or `-`). */
export const RESERVED_HANDLES: readonly string[] = [
  'admin',
  'administrator',
  'anonymous',
  'api',
  'deleted',
  'flocked',
  'flockedxyz',
  'guardian',
  'help',
  'mod',
  'moderator',
  'official',
  'root',
  'security',
  'staff',
  'support',
  'system',
  'team',
];

const RESERVED = new Set(RESERVED_HANDLES);

/** A handle's normal form for the blocklist: lowercase, without `_` and `-`. */
export function reservedHandleForm(handle: string): string {
  return handle.toLowerCase().replace(/[_-]/g, '');
}

/** True when `handle` is on the blocklist, ignoring case and separators. */
export function isReservedHandle(handle: string): boolean {
  return RESERVED.has(reservedHandleForm(handle));
}
