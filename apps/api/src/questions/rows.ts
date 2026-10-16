// Question rows (D1 `questions`) and the wire `Question` built from them. Every stored value the
// wire shape constrains is parsed with the shared schemas, so a bad D1 value fails the read loudly
// (logged, 500) instead of being served: a bad category once broke GET /rounds/:id for clients
// while the API answered 200 (W7-D; migration 0017).
//
// Authors are served as public users. A deleted account is already anonymized in D1; a merged one
// keeps its old profile there. Neither is shown: both are served as the opaque ID alone, so a
// question never names an account that no longer exists or links it to the account it merged into.
import {
  QuestionOptionSchema,
  QuestionSchema,
  type PublicUser,
  type Question,
  type QuestionOption,
} from '@flocked/shared';
import { z } from 'zod';
import { log } from '../lib/log.js';
import { servedScore } from './score.js';

/** One `questions` row. */
export interface QuestionRow {
  id: string;
  author_user_id: string | null;
  prompt: string;
  options_json: string;
  category: string;
  status: string;
  moderation_json: string | null;
  /** Epoch-scaled vote sum (src/questions/score.ts); serve it with `servedScore`. */
  score: number;
  created_at: number;
  needs_review: number;
  rejection_reason: string | null;
  rejected_at: number | null;
}

/** The author columns `QUESTION_SELECT` joins in (`users` as `a`). */
export interface QuestionAuthorColumns {
  a_status: string | null;
  a_handle: string | null;
  a_display_name: string | null;
  a_avatar_url: string | null;
}

export type QuestionWithAuthorRow = QuestionRow & QuestionAuthorColumns;

/** Every `questions` column, from the alias `q`. */
export const QUESTION_COLUMNS =
  'q.id, q.author_user_id, q.prompt, q.options_json, q.category, q.status, q.moderation_json, ' +
  'q.score, q.created_at, q.needs_review, q.rejection_reason, q.rejected_at';

/** The author's columns, from the alias `a` (`LEFT JOIN users a ON a.id = q.author_user_id`). */
export const QUESTION_AUTHOR_COLUMNS =
  'a.status AS a_status, a.handle AS a_handle, a.display_name AS a_display_name, ' +
  'a.avatar_url AS a_avatar_url';

/** `SELECT` of a question and its author; append `WHERE …` (aliases `q` and `a`). */
export const QUESTION_SELECT =
  `SELECT ${QUESTION_COLUMNS}, ${QUESTION_AUTHOR_COLUMNS} ` +
  'FROM questions q LEFT JOIN users a ON a.id = q.author_user_id';

/** Statuses whose profile is shown on the author's questions. */
const SHOWN_STATUSES: ReadonlySet<string> = new Set(['active', 'suspended']);

/**
 * The author as served: null for a house question; the opaque ID alone for a deleted or merged
 * account (or one that is missing); otherwise the public profile.
 */
export function questionAuthor(row: {
  author_user_id: string | null;
  a_status: string | null;
  a_handle: string | null;
  a_display_name: string | null;
  a_avatar_url: string | null;
}): PublicUser | null {
  if (row.author_user_id === null) return null;
  if (row.a_status === null || !SHOWN_STATUSES.has(row.a_status)) {
    return { id: row.author_user_id, handle: null, displayName: null, avatarUrl: null };
  }
  return {
    id: row.author_user_id,
    handle: row.a_handle,
    displayName: row.a_display_name,
    avatarUrl: row.a_avatar_url,
  };
}

const OptionsSchema = z.tuple([QuestionOptionSchema, QuestionOptionSchema]);

/** A stored question that fails its wire schema: thrown, never served. */
export class InvalidQuestionRowError extends Error {
  override readonly name = 'InvalidQuestionRowError';
  constructor(readonly questionId: string) {
    super(`question ${questionId} has a stored value that fails its schema`);
  }
}

/** The stored options, parsed with `QuestionOptionSchema` (throws on a malformed value). */
export function parseOptions(
  row: Pick<QuestionRow, 'id' | 'options_json'>,
): [QuestionOption, QuestionOption] {
  let raw: unknown;
  try {
    raw = JSON.parse(row.options_json);
  } catch {
    raw = undefined;
  }
  const parsed = OptionsSchema.safeParse(raw);
  if (!parsed.success) {
    log.error('question_row_invalid', { questionId: row.id, fields: ['options'] });
    throw new InvalidQuestionRowError(row.id);
  }
  return parsed.data;
}

/**
 * The wire `Question` for a row: the score decayed to `t` and rounded (`servedScore`), and the
 * whole view (options, category, status, author, ...) parsed with `QuestionSchema`. `author` is the
 * served author (`questionAuthor(row)` for a `QUESTION_SELECT` row).
 */
export function questionView(row: QuestionRow, author: PublicUser | null, t: number): Question {
  const view = {
    id: row.id,
    prompt: row.prompt,
    options: parseOptions(row),
    category: row.category,
    status: row.status,
    score: servedScore(row.score, t),
    author,
    createdAt: row.created_at,
  };
  const parsed = QuestionSchema.safeParse(view);
  if (!parsed.success) {
    log.error('question_row_invalid', {
      questionId: row.id,
      fields: parsed.error.issues.map((i) => i.path.map(String).join('.')),
    });
    throw new InvalidQuestionRowError(row.id);
  }
  return parsed.data;
}
