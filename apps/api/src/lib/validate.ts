// zod validation middleware (spec "API": every request body is validated with zod). A failure is a
// 400 `bad_request` envelope naming the first few issues; the handler reads the parsed value with
// `c.req.valid(target)`.
import type { ValidationTargets } from 'hono';
import { validator } from 'hono/validator';
import type { z } from 'zod';
import { errorResponse } from './errors.js';

export type ValidateTarget = keyof Pick<ValidationTargets, 'json' | 'query' | 'param'>;

const MAX_ISSUES = 5;

/** A short human-readable summary of zod issues: `path: message; path: message`. */
export function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.map(String).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length - MAX_ISSUES;
  return more > 0 ? `${parts.join('; ')}; and ${more} more` : parts.join('; ');
}

/** Validates the request `target` against `schema`. */
export function validate<Target extends ValidateTarget, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return validator(target, async (value, c) => {
    const parsed = await schema.safeParseAsync(value);
    if (!parsed.success) {
      return errorResponse(c, 'bad_request', `Invalid ${target}: ${describeIssues(parsed.error)}`);
    }
    return parsed.data;
  });
}
