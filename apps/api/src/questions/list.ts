// GET /questions (spec "API": "Questions in the voting queue"; "Question pipeline" step 3).
//
//   * `queued` (the default) is the public vote queue: `submitted` without a pending review, and
//     admin-approved `queued` questions. Questions waiting for an admin review are never listed.
//   * `scheduled` lists only the caller's own scheduled questions (none for an anonymous caller):
//     anyone else's would show an upcoming daily question before its lock, and a round is public
//     only once its question is locked (spec "API" › Reveal gating).
//   * `used` lists questions used by a locked daily round, so a room's question never shows here.
//
// `top` (the default) is the top 50 by decayed score in one page: `questions.score` is stored
// epoch-scaled, so ORDER BY score is the decayed order (./score.ts). `new` pages by creation time,
// newest first, with a keyset cursor (./cursor.ts). For a signed-in caller each question carries
// their vote (`myVote`) and the response their submission quota.
import {
  EpochMsSchema,
  QUEUE_TOP_LIMIT,
  UlidSchema,
  type QuestionsListQuery,
  type QuestionsListResponse,
} from '@flocked/shared';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { quotaOf } from './quota.js';
import {
  QUESTION_SELECT,
  questionAuthor,
  questionView,
  type QuestionWithAuthorRow,
} from './rows.js';
import { VOTE_QUEUE_SQL } from './votes.js';

/** Page size of `sort=new` without `limit`. */
export const QUESTIONS_PAGE_DEFAULT = 20;

/** The `sort=new` cursor: the last row's (createdAt, id). */
const NewCursorSchema = z.tuple([EpochMsSchema, UlidSchema]);

type Status = NonNullable<QuestionsListQuery['status']>;

/** The WHERE condition and binds for a status (binds from ?1), or null when nothing can match. */
function statusFilter(status: Status, viewerId: string | null): [string, unknown[]] | null {
  switch (status) {
    case 'queued':
      return [VOTE_QUEUE_SQL, []];
    case 'scheduled':
      if (viewerId === null) return null;
      return ["q.status = 'scheduled' AND q.author_user_id = ?1", [viewerId]];
    case 'used':
      return [
        "q.status = 'used' AND EXISTS (SELECT 1 FROM rounds r WHERE r.question_id = q.id " +
          "AND r.kind = 'daily' AND r.locked_at IS NOT NULL)",
        [],
      ];
  }
}

/** The caller's votes on `ids`. */
async function votesOf(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<Map<string, 1 | -1>> {
  if (ids.length === 0) return new Map();
  const { results } = await db
    .prepare(
      'SELECT question_id, value FROM question_votes WHERE user_id = ?1 ' +
        'AND question_id IN (SELECT value FROM json_each(?2))',
    )
    .bind(userId, JSON.stringify(ids))
    .all<{ question_id: string; value: 1 | -1 }>();
  return new Map(results.map((r) => [r.question_id, r.value]));
}

/** One page of rows for the query. */
async function pageOf(
  db: D1Database,
  filter: [string, unknown[]],
  sort: 'top' | 'new',
  limitParam: number | undefined,
  after: [number, string] | null,
): Promise<{ rows: QuestionWithAuthorRow[]; nextCursor: string | null }> {
  const [where, binds] = filter;
  const n = binds.length;
  if (sort === 'top') {
    const limit = Math.min(limitParam ?? QUEUE_TOP_LIMIT, QUEUE_TOP_LIMIT);
    const { results } = await db
      .prepare(
        `${QUESTION_SELECT} WHERE ${where} ` +
          `ORDER BY q.score DESC, q.created_at ASC, q.id ASC LIMIT ?${n + 1}`,
      )
      .bind(...binds, limit)
      .all<QuestionWithAuthorRow>();
    return { rows: results, nextCursor: null };
  }
  const limit = limitParam ?? QUESTIONS_PAGE_DEFAULT;
  const keyset = after
    ? ` AND (q.created_at < ?${n + 2} OR (q.created_at = ?${n + 2} AND q.id < ?${n + 3}))`
    : '';
  const { results } = await db
    .prepare(
      `${QUESTION_SELECT} WHERE ${where}${keyset} ` +
        `ORDER BY q.created_at DESC, q.id DESC LIMIT ?${n + 1}`,
    )
    .bind(...binds, limit + 1, ...(after ?? []))
    .all<QuestionWithAuthorRow>();
  const rows = results.slice(0, limit);
  const last = rows[rows.length - 1];
  const more = results.length > limit && last !== undefined;
  return { rows, nextCursor: more ? encodeCursor([last.created_at, last.id]) : null };
}

export async function listQuestions(
  db: D1Database,
  query: QuestionsListQuery,
  viewerId: string | null,
  t: number,
): Promise<QuestionsListResponse> {
  const status = query.status ?? 'queued';
  const sort = query.sort ?? 'top';
  if (sort === 'top' && query.cursor !== undefined) {
    throw new HttpError('bad_request', 'The top list is one page; cursor applies to sort=new');
  }
  const after = query.cursor ? decodeCursor(query.cursor, NewCursorSchema) : null;
  const filter = statusFilter(status, viewerId);
  const [{ rows, nextCursor }, quota] = await Promise.all([
    filter ? pageOf(db, filter, sort, query.limit, after) : { rows: [], nextCursor: null },
    viewerId === null ? null : quotaOf(db, viewerId, t),
  ]);
  const votes =
    viewerId === null
      ? new Map<string, 1 | -1>()
      : await votesOf(
          db,
          viewerId,
          rows.map((r) => r.id),
        );
  return {
    questions: rows.map((r) => ({
      ...questionView(r, questionAuthor(r), t),
      myVote: votes.get(r.id) ?? null,
    })),
    nextCursor,
    quota,
  };
}
