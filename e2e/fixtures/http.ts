// The harness's HTTP helper (W7-D). Every answer the stack gives is JSON, so a non-JSON body is
// reported with its status and first bytes instead of a bare SyntaxError: `wrangler dev` can drop a
// request under load and answer workerd's plain-text "Network connection lost" (wave-7.md, W6-Z
// carry-over; Stack run 38305750622). Only idempotent requests are retried: a GET, or a write the
// caller marks idempotent (a Free entry is: one per user and mode, so a retried POST that had
// landed answers `already_entered`, never a second entry).

export interface HttpInit {
  method?: string;
  body?: unknown;
  /** Bearer token. */
  token?: string;
  /** Sent as CF-Connecting-IP, which `wrangler dev` honours: one IP per player stays under the per-IP buckets. */
  ip?: string;
  headers?: Record<string, string>;
  /** Retry a dropped connection or a non-JSON answer. GET and HEAD always are. */
  idempotent?: boolean;
}

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  /** How many attempts it took (1 unless a dropped request was retried). */
  attempts: number;
}

/** A response that wasn't JSON: the stack dropped it, or something other than the API answered. */
export class NonJsonResponse extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly text: string,
  ) {
    super(`${url} answered ${status} with a non-JSON body: ${JSON.stringify(text.slice(0, 200))}`);
  }
}

const RETRIES = 3;
const RETRY_DELAY_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One attempt: the parsed JSON body (null when empty), or NonJsonResponse. */
async function once(url: string, init: HttpInit): Promise<HttpResult> {
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    redirect: 'manual',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.ip ? { 'cf-connecting-ip': init.ip } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (text === '') return { status: res.status, body: null, headers: res.headers, attempts: 1 };
  try {
    return {
      status: res.status,
      body: JSON.parse(text) as unknown,
      headers: res.headers,
      attempts: 1,
    };
  } catch {
    throw new NonJsonResponse(url, res.status, text);
  }
}

/**
 * A JSON request. A network error or a non-JSON answer is retried (up to 3 times, 0.5 s apart)
 * only when the request is idempotent; otherwise it is thrown, naming the URL, status and body.
 */
export async function http<T = unknown>(url: string, init: HttpInit = {}): Promise<HttpResult<T>> {
  const method = (init.method ?? (init.body === undefined ? 'GET' : 'POST')).toUpperCase();
  const retryable = init.idempotent === true || method === 'GET' || method === 'HEAD';
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await once(url, init);
      return { ...r, attempts: attempt } as HttpResult<T>;
    } catch (err) {
      const dropped = err instanceof NonJsonResponse || err instanceof TypeError;
      if (!retryable || !dropped || attempt > RETRIES) {
        if (err instanceof TypeError) {
          throw new Error(`${method} ${url}: ${err.message} (${attempt} attempt(s))`, {
            cause: err,
          });
        }
        throw err;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}
