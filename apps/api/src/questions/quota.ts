// Submission limits (spec "Question pipeline" step 1; "Anti-abuse" › Spam questions): 3 submissions
// per game day, and after 5 rejected submissions in 7 days, submission is blocked for 7 days
// (`limits.question_block_until`); play is unaffected. Rejections count by when they happened
// (`questions.rejected_at`), whether moderation or an admin rejected the question.
import {
  QUESTION_BLOCK_MS,
  QUESTION_REJECTION_LIMIT,
  QUESTION_REJECTION_WINDOW_MS,
  QUESTIONS_PER_DAY,
  dailyClosesAt,
  dailyOpensAt,
  openGameDayAt,
  type QuestionQuota,
} from '@flocked/shared';

/** The current game day's window [start, end) in epoch ms: 21:00 to 21:00 New York. */
export function gameDayWindow(t: number): { start: number; end: number } {
  const day = openGameDayAt(Math.floor(t / 1000));
  return { start: dailyOpensAt(day) * 1000, end: dailyClosesAt(day) * 1000 };
}

/** SQL: the author's submissions in the game day window, as `n` (?1 author, ?2 start, ?3 end). */
export const SUBMITTED_TODAY_SQL =
  'SELECT COUNT(*) AS n FROM questions WHERE author_user_id = ?1 AND created_at >= ?2 AND created_at < ?3';

/**
 * The statement that blocks submission for 7 days once the author has 5 rejections in the last 7
 * days. Run it in the same batch as (after) the statement that rejects a question, so the count
 * includes it. A longer block already in place is kept.
 */
export function blockAfterRejection(
  db: D1Database,
  authorUserId: string,
  t: number,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO limits (user_id, question_block_until) ' +
        'SELECT ?1, ?2 + ?3 WHERE (SELECT COUNT(*) FROM questions WHERE author_user_id = ?1 ' +
        'AND rejected_at IS NOT NULL AND rejected_at > ?2 - ?4) >= ?5 ' +
        'ON CONFLICT (user_id) DO UPDATE SET question_block_until = ' +
        'MAX(COALESCE(question_block_until, 0), excluded.question_block_until)',
    )
    .bind(
      authorUserId,
      t,
      QUESTION_BLOCK_MS,
      QUESTION_REJECTION_WINDOW_MS,
      QUESTION_REJECTION_LIMIT,
    );
}

/** The caller's allowance now (`QuestionQuota`). */
export async function quotaOf(db: D1Database, userId: string, t: number): Promise<QuestionQuota> {
  const { start, end } = gameDayWindow(t);
  const [today, rejections, limits] = await db.batch<Record<string, number | null>>([
    db.prepare(SUBMITTED_TODAY_SQL).bind(userId, start, end),
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM questions WHERE author_user_id = ?1 AND rejected_at IS NOT NULL AND rejected_at > ?2',
      )
      .bind(userId, t - QUESTION_REJECTION_WINDOW_MS),
    db.prepare('SELECT question_block_until AS until FROM limits WHERE user_id = ?1').bind(userId),
  ]);
  const submitted = Number(today?.results[0]?.n ?? 0);
  const until = limits?.results[0]?.until ?? null;
  return {
    remainingToday: Math.max(0, QUESTIONS_PER_DAY - submitted),
    rejectionsLast7Days: Number(rejections?.results[0]?.n ?? 0),
    blockedUntil: until !== null && until > t ? until : null,
  };
}
