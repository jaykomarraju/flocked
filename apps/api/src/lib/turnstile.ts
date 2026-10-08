// Cloudflare Turnstile server-side check (spec "Anti-abuse": sign-up, question submission and the
// first Free entry of each game day). The fetch is injectable so tests never touch the network.
import type { Env } from '../env.js';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  success: boolean;
  /** Turnstile's `error-codes`, plus `missing-input-secret` when the secret is unset locally. */
  errorCodes: string[];
  hostname?: string;
  action?: string;
}

export interface VerifyTurnstileOptions {
  /** The client IP (CF-Connecting-IP); sent to Turnstile only, never stored. */
  remoteIp?: string;
  /** Expected widget action; a mismatch fails the check. */
  expectedAction?: string;
  /** Idempotency key so a retried siteverify call is not counted as token reuse. */
  idempotencyKey?: string;
  fetch?: typeof fetch;
}

interface SiteverifyBody {
  success?: unknown;
  'error-codes'?: unknown;
  hostname?: unknown;
  action?: unknown;
}

/** Verifies a Turnstile token with siteverify. Never throws for a rejected token. */
export async function verifyTurnstile(
  env: Pick<Env, 'TURNSTILE_SECRET_KEY'>,
  token: string,
  opts: VerifyTurnstileOptions = {},
): Promise<TurnstileResult> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return { success: false, errorCodes: ['missing-input-secret'] };
  if (!token || token.length > 2048)
    return { success: false, errorCodes: ['invalid-input-response'] };

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (opts.remoteIp) form.append('remoteip', opts.remoteIp);
  if (opts.idempotencyKey) form.append('idempotency_key', opts.idempotencyKey);

  const doFetch = opts.fetch ?? fetch;
  let body: SiteverifyBody;
  try {
    const res = await doFetch(SITEVERIFY_URL, { method: 'POST', body: form });
    if (!res.ok) return { success: false, errorCodes: [`http-${res.status}`] };
    body = await res.json<SiteverifyBody>();
  } catch {
    return { success: false, errorCodes: ['internal-error'] };
  }

  const errorCodes = Array.isArray(body['error-codes'])
    ? body['error-codes'].filter((x): x is string => typeof x === 'string')
    : [];
  const result: TurnstileResult = { success: body.success === true, errorCodes };
  if (typeof body.hostname === 'string') result.hostname = body.hostname;
  if (typeof body.action === 'string') result.action = body.action;
  if (
    result.success &&
    opts.expectedAction !== undefined &&
    result.action !== opts.expectedAction
  ) {
    return { ...result, success: false, errorCodes: [...errorCodes, 'action-mismatch'] };
  }
  return result;
}
