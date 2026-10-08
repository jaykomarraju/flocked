// Structured JSON logs (one object per line, read by Workers Logs). Redaction follows the sealed-pick
// rule (plan P2.4; spec "Sealed picks"): nothing that could reveal a pick may be logged before the
// beacon. Fields named in REDACTED_FIELDS are dropped at any depth unless the caller passes
// `{ afterBeacon: true }`.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Field names dropped before the beacon. `option_index` (the D1 column) is included alongside the
 * pinned `optionIndex`, `plaintext` and `nonce` so a logged row cannot leak a pick either.
 */
export const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  'optionIndex',
  'option_index',
  'plaintext',
  'nonce',
]);

export interface LogOptions {
  /** Set only when the data concerns a mode whose beacon has been published. */
  afterBeacon?: boolean;
}

const MAX_DEPTH = 8;

/** A JSON-safe deep copy of `value` with redacted fields removed (unless after the beacon). */
export function redact(value: unknown, opts: LogOptions = {}): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v === null || typeof v !== 'object') {
      return typeof v === 'function' || typeof v === 'symbol' ? undefined : v;
    }
    if (seen.has(v)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Truncated]';
    seen.add(v);
    try {
      if (v instanceof Error) {
        return { name: v.name, message: v.message };
      }
      if (v instanceof Uint8Array) return `[${v.length} bytes]`;
      if (v instanceof Date) return v.toISOString();
      if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) {
        if (!opts.afterBeacon && REDACTED_FIELDS.has(k)) continue;
        const w = walk(item, depth + 1);
        if (w !== undefined) out[k] = w;
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, 0);
}

/** The JSON line for one log event. `level` and `event` always win over same-named data fields. */
export function formatLog(
  level: LogLevel,
  event: string,
  data: Record<string, unknown> = {},
  opts: LogOptions = {},
): string {
  const clean = redact(data, opts) as Record<string, unknown>;
  return JSON.stringify({ ...clean, level, event });
}

function emit(level: LogLevel, event: string, data?: Record<string, unknown>, opts?: LogOptions) {
  const line = formatLog(level, event, data, opts);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, data?: Record<string, unknown>, opts?: LogOptions) =>
    emit('debug', event, data, opts),
  info: (event: string, data?: Record<string, unknown>, opts?: LogOptions) =>
    emit('info', event, data, opts),
  warn: (event: string, data?: Record<string, unknown>, opts?: LogOptions) =>
    emit('warn', event, data, opts),
  error: (event: string, data?: Record<string, unknown>, opts?: LogOptions) =>
    emit('error', event, data, opts),
};
