// Helpers for the /questions route tests: an env with fake Turnstile and moderation (the rubric model
// decides by a marker in the prompt: `#reject` → a failed check, `#review` → a refusal, else pass),
// a pinned clock, users, question rows and request helpers.
import { env } from 'cloudflare:test';
import { API_BASE_PATH, ErrorEnvelopeSchema, newUlid, type QuestionStatus } from '@flocked/shared';
import { vi } from 'vitest';
import { app } from '../../src/app.js';
import { withAuthDeps } from '../../src/auth/deps.js';
import type { Env } from '../../src/env.js';
import type { SessionUser } from '../../src/lib/auth-context.js';
import { withModerationDeps } from '../../src/moderation/deps.js';
import type {
  DuplicateIndex,
  ModelVerdict,
  ModerationInput,
  ModerationModel,
} from '../../src/moderation/index.js';
import { voteWeight } from '../../src/questions/score.js';
import { fakeUser, withSession } from '../helpers/index.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 2026-10-15 12:00 New York (EDT): mid game day (2026-10-14 21:00 to 2026-10-15 21:00). */
export const T0 = Date.UTC(2026, 9, 15, 16, 0, 0);
/** The end of T0's game day: 2026-10-15 21:00 New York. */
export const T0_DAY_END = Date.UTC(2026, 9, 16, 1, 0, 0);

export const REJECT_REASON = 'Keep it friendly and about everyday choices.';

/** The rubric model's verdict for a question, by the marker in its prompt. */
export function verdictFor(input: ModerationInput): ModelVerdict {
  if (input.prompt.includes('#review')) return { kind: 'refusal', category: null };
  const output = {
    safe: !input.prompt.includes('#reject'),
    twoSided: true,
    preferenceBased: true,
    predictedSplit: 0.6,
    reason: input.prompt.includes('#reject') ? REJECT_REASON : '',
  };
  return { kind: 'verdict', output, stopReason: 'end_turn' };
}

export const siteverify = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.resolve(Response.json({ success: true })),
);
export const model = {
  classify: vi.fn<ModerationModel['classify']>((q) => Promise.resolve(verdictFor(q))),
};
export const duplicates = {
  findDuplicate: vi.fn<DuplicateIndex['findDuplicate']>(() => Promise.resolve(null)),
  add: vi.fn<DuplicateIndex['add']>(() => Promise.resolve()),
};

/** The env the routes run with: fake Turnstile fetch and moderation, the clock pinned to T0. */
export function questionsEnv(): Env {
  const e = withModerationDeps(withAuthDeps(env, { turnstileFetch: siteverify }), {
    model,
    duplicates,
  });
  return Object.assign(e, { ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(T0) });
}

/** Pins the clock of `e` (and of the test env the DOs see) to `ms`. */
export function setClock(e: Env, ms: number): void {
  for (const target of [e, env]) {
    Object.assign(target, { ENVIRONMENT: 'local', FLOCKED_TEST_CLOCK: String(ms) });
  }
}

export interface TestUser {
  id: string;
  handle: string;
  user: SessionUser;
}

/** Inserts a user (active unless `status` says otherwise). */
export async function createUser(
  opts: { status?: 'active' | 'suspended' | 'merged' | 'deleted'; mergedInto?: string } = {},
): Promise<TestUser> {
  const id = newUlid();
  const handle = `q_${id.slice(-10).toLowerCase()}`;
  await env.DB.prepare(
    "INSERT INTO users (id, handle, display_name, role, status, merged_into, ref_code, created_at) VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6, ?7)",
  )
    .bind(
      id,
      handle,
      `Name ${handle}`,
      opts.status ?? 'active',
      opts.mergedInto ?? null,
      `Q${id.slice(-12)}`,
      T0 - 30 * DAY,
    )
    .run();
  const status = opts.status === 'suspended' ? 'suspended' : 'active';
  return { id, handle, user: fakeUser({ id, status }) };
}

export interface QuestionSeed {
  id?: string;
  authorId?: string | null;
  prompt?: string;
  options?: { label: string; emoji: string }[];
  category?: string;
  status?: QuestionStatus;
  needsReview?: boolean;
  score?: number;
  createdAt?: number;
}

/** Inserts a question row directly; returns its ID. */
export async function insertQuestion(q: QuestionSeed = {}): Promise<string> {
  const id = q.id ?? newUlid(q.createdAt ?? T0 - DAY);
  const status = q.status ?? 'submitted';
  const createdAt = q.createdAt ?? T0 - DAY;
  await env.DB.prepare(
    'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, score, created_at, needs_review, rejection_reason, rejected_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)',
  )
    .bind(
      id,
      q.authorId ?? null,
      q.prompt ?? `Question ${id}?`,
      JSON.stringify(
        q.options ?? [
          { label: 'Yes', emoji: '👍' },
          { label: 'No', emoji: '' },
        ],
      ),
      q.category ?? 'life',
      status,
      q.score ?? 0,
      createdAt,
      q.needsReview ? 1 : 0,
      status === 'rejected' ? 'Rejected' : null,
      status === 'rejected' ? createdAt : null,
    )
    .run();
  return id;
}

/** Inserts a locked round of `kind` for a question. */
export async function insertRound(questionId: string, kind: 'daily' | 'room', closesAt: number) {
  const roomId = kind === 'room' ? newUlid() : null;
  await env.DB.prepare(
    "INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, beacon_round, status, locked_at, config_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'closed', ?7, '{}')",
  )
    .bind(newUlid(), kind, roomId, questionId, closesAt - DAY, closesAt, closesAt - DAY - 6 * HOUR)
    .run();
}

/** A vote row as if cast at `castAt` (the score is not recomputed). */
export function voteRow(questionId: string, userId: string, value: 1 | -1, castAt: number) {
  return env.DB.prepare(
    'INSERT INTO question_votes (question_id, user_id, value, created_at, weight) VALUES (?1, ?2, ?3, ?4, ?5)',
  ).bind(questionId, userId, value, castAt, voteWeight(castAt));
}

export const VALID_BODY = {
  prompt: 'Window seat or aisle seat?',
  options: [{ label: 'Window', emoji: '🪟' }, { label: 'Aisle' }],
  category: 'life',
  turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
};

const url = (path: string) => `https://flocked.test${API_BASE_PATH}${path}`;

/** A request through the full app, as `as` (anonymous when undefined). */
export function call(
  e: Env,
  as: SessionUser | undefined,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json', ...headers };
    init.body = JSON.stringify(body);
  }
  const client = as ? withSession(app, as) : app;
  return Promise.resolve(client.request(url(path), init, e));
}

export const submit = (e: Env, as: SessionUser | undefined, body: unknown = VALID_BODY) =>
  call(e, as, 'POST', '/questions', body);

export const vote = (e: Env, as: SessionUser | undefined, id: string, value: unknown) =>
  call(e, as, 'POST', `/questions/${id}/vote`, { value });

export const list = (e: Env, as: SessionUser | undefined, query = '') =>
  call(e, as, 'GET', `/questions${query}`);

/** The error code of an error response. */
export async function errorCode(res: Response): Promise<string> {
  return ErrorEnvelopeSchema.parse(await res.json()).error.code;
}

/** Number of questions authored by `userId`. */
export async function countQuestions(userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions WHERE author_user_id = ?1')
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
