// Votes on the queue (spec "Question pipeline" step 3; POST /questions/:id/vote). Only questions in
// the vote queue take votes: passed moderation (`submitted` without a pending review) or approved
// (`queued`). A repeat vote replaces the earlier one, recast now: its value, time and weight.
//
// One batch: the vote (guarded by the vote-queue condition again, so a question that left the queue
// since the check gets no vote), the question's score recomputed from all its votes, and the score.
// `questions.score` is the epoch-scaled sum (./score.ts), served decayed to now.
import type { VoteQuestionResponse } from '@flocked/shared';
import { HttpError } from '../lib/errors.js';
import { servedScore, voteWeight } from './score.js';

/** SQL: the question (alias `q`) is in the public vote queue (a room's question never is). */
export const VOTE_QUEUE_SQL =
  "q.room_id IS NULL AND q.status IN ('submitted', 'queued') AND q.needs_review = 0";

interface VoteTarget {
  author_user_id: string | null;
  in_queue: number;
}

export async function castVote(
  db: D1Database,
  vote: { questionId: string; userId: string; value: 1 | -1 },
  t: number,
): Promise<VoteQuestionResponse> {
  const { questionId, userId, value } = vote;
  const target = await db
    .prepare(
      `SELECT q.author_user_id, (${VOTE_QUEUE_SQL}) AS in_queue FROM questions q WHERE q.id = ?1`,
    )
    .bind(questionId)
    .first<VoteTarget>();
  if (!target) throw new HttpError('not_found', 'No such question');
  if (target.author_user_id === userId) {
    throw new HttpError('forbidden', 'You cannot vote on your own question');
  }
  if (target.in_queue !== 1) {
    throw new HttpError('conflict', 'This question is not open for votes');
  }

  const [inserted, , score] = await db.batch([
    db
      .prepare(
        'INSERT INTO question_votes (question_id, user_id, value, created_at, weight) ' +
          `SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM questions q WHERE q.id = ?1 AND ${VOTE_QUEUE_SQL}) ` +
          'ON CONFLICT (question_id, user_id) DO UPDATE SET value = excluded.value, ' +
          'created_at = excluded.created_at, weight = excluded.weight',
      )
      .bind(questionId, userId, value, t, voteWeight(t)),
    db
      .prepare(
        'UPDATE questions SET score = ' +
          '(SELECT COALESCE(SUM(value * weight), 0) FROM question_votes WHERE question_id = ?1) ' +
          'WHERE id = ?1',
      )
      .bind(questionId),
    db.prepare('SELECT score FROM questions WHERE id = ?1').bind(questionId),
  ]);
  if (!inserted || inserted.meta.changes === 0) {
    throw new HttpError('conflict', 'This question is not open for votes');
  }
  const stored = (score?.results[0] as { score: number } | undefined)?.score ?? 0;
  return { questionId, value, score: servedScore(stored, t) };
}
