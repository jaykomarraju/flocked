// POST /rooms/:id/questions (spec "API": owner only, "Set a custom question for the next room round
// (before its question lock)"; "Profiles, leaderboards and rooms" › Rooms: a custom room runs a
// question set by the owner, "using the same moderation step").
//
// In order: the room (404 unknown, closed or not a member; 403 `forbidden` for a member who isn't the
// owner; 409 `conflict` for a mirror room, whose rounds take the daily question); the format, as POST
// /questions checks it (src/questions/format.ts); the submission allowance POST /questions applies
// (src/questions/quota.ts: a room question is a question submission, so it counts toward the 3 per
// game day and the 5-rejections block, and moderation isn't run past them); the target round: the
// room's earliest unlocked room round whose question lock (opensAt − LOCK_LEAD_MS) is still ahead,
// after `insertRoomRoundsAhead` (none → 409 `conflict`); moderation (`moderateQuestion`).
//
// A room question is private to the room: it is stored with `room_id`, never enters the vote queue
// or the duplicate index (`indexQuestion` is not called), and the public reads leave it out
// (`room_id IS NULL`). Duplicates of public questions don't matter for it, so a rejection whose only
// cause is a duplicate counts as a pass, and so does a review whose only cause is a failed duplicate
// lookup (the model's verdict passed every check in both cases); the hit stays in moderation_json.
//
// Outcomes (all 201, as POST /questions answers every outcome):
//   * pass → the question `scheduled` with `room_id`, and the target round's `question_id`, in one
//     batch that applies only while the round is still unlocked with its lock ahead (a lost race →
//     409 `conflict`, nothing stored). The lock (src/scheduler/lock.ts) takes it. Before the lock the
//     owner may replace it; the replaced question stays `scheduled`, on no round;
//   * reject → `rejected` with its reason, and the 7-day block check, as POST /questions does; the
//     round is left as it is;
//   * review (a refusal or a failed model call) → `submitted` with `needs_review`, for an admin, as
//     POST /questions does; the round is left as it is.
// `roundId` is the target round in every outcome.
import {
  QUESTIONS_PER_DAY,
  newUlid,
  type ModerationOutcome,
  type SetRoomQuestionRequest,
  type SetRoomQuestionResponse,
} from '@flocked/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import {
  moderateQuestion,
  type ModerationDecision,
  type ModerationInput,
  type ModerationResult,
} from '../moderation/index.js';
import { cleanQuestionInput, storedOptionsJson } from '../questions/format.js';
import {
  SUBMITTED_TODAY_SQL,
  blockAfterRejection,
  gameDayWindow,
  quotaOf,
} from '../questions/quota.js';
import { refuseOverQuota } from '../questions/submit.js';
import {
  QUESTION_SELECT,
  questionAuthor,
  questionView,
  type QuestionWithAuthorRow,
} from '../questions/rows.js';
import { LOCK_LEAD_MS } from '../scheduler/lock.js';
import { memberRoom } from './rows.js';
import { insertRoomRoundsAhead } from './schedule.js';

type Ctx = Context<AppEnv>;

/** Stored when moderation rejects without a reason (it always gives one; the column needs one). */
const DEFAULT_REJECTION_REASON = 'This question was not accepted.';

const OUTCOMES: Record<ModerationDecision, ModerationOutcome['outcome']> = {
  pass: 'queued',
  reject: 'rejected',
  review: 'review',
};

/**
 * Moderation as it applies to a room question: a duplicate of a public question is no reason to
 * refuse it. A rejection only for a duplicate, or a review only for a failed duplicate lookup, is a
 * pass (the model's checks all passed in both cases: decide() looks at duplicates only then).
 */
export function roomModeration(result: ModerationResult): ModerationResult {
  const output = result.json.output;
  const checksPassed = output !== null && output.safe && output.twoSided && output.preferenceBased;
  const duplicateOnly =
    checksPassed &&
    ((result.decision === 'reject' && result.duplicateOf !== null) ||
      (result.decision === 'review' && result.json.reviewCause === 'duplicate_lookup_failed'));
  if (!duplicateOnly) return result;
  return {
    ...result,
    decision: 'pass',
    reason: null,
    json: { ...result.json, decision: 'pass', reason: null, reviewCause: null },
  };
}

/** The room's earliest round that can still take a question at `t`, or null. */
async function targetRound(db: D1Database, roomId: string, t: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM rounds
       WHERE kind = 'room' AND room_id = ?1 AND locked_at IS NULL AND status = 'scheduled'
         AND opens_at - ?3 > ?2
       ORDER BY opens_at, id LIMIT 1`,
    )
    .bind(roomId, t, LOCK_LEAD_MS)
    .first<{ id: string }>();
  return row?.id ?? null;
}

// ?15 room, ?16 round, ?17 LOCK_LEAD_MS, ?18 the time after moderation: the round can still take a
// question (a fresh clock: moderation can take tens of seconds, W8-F1 M1).
const ROUND_OPEN_FOR_QUESTION =
  "EXISTS (SELECT 1 FROM rounds WHERE id = ?16 AND kind = 'room' AND room_id = ?15 " +
  "AND locked_at IS NULL AND status = 'scheduled' AND opens_at - ?17 > ?18)";

/**
 * The insert (guarded by the allowance like POST /questions', and for a pass by the round), the
 * round's question for a pass, the block check for a rejection, and the stored row, as one batch.
 */
async function store(
  db: D1Database,
  q: { id: string; authorId: string; roomId: string; roundId: string; t: number; storeAt: number },
  input: ModerationInput,
  result: ModerationResult,
): Promise<QuestionWithAuthorRow | null> {
  const { start, end } = gameDayWindow(q.t);
  const passed = result.decision === 'pass';
  const rejected = result.decision === 'reject';
  const status = passed ? 'scheduled' : rejected ? 'rejected' : 'submitted';
  const args: unknown[] = [
    q.authorId,
    start,
    end,
    q.id,
    input.prompt,
    storedOptionsJson(input.options),
    input.category,
    status,
    JSON.stringify(result.json),
    q.t,
    result.decision === 'review' ? 1 : 0,
    rejected ? (result.reason ?? DEFAULT_REJECTION_REASON) : null,
    rejected ? q.t : null,
    QUESTIONS_PER_DAY,
    q.roomId,
  ];
  if (passed) args.push(q.roundId, LOCK_LEAD_MS, q.storeAt);
  const insert = db
    .prepare(
      'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, ' +
        'moderation_json, score, created_at, needs_review, rejection_reason, rejected_at, room_id) ' +
        'SELECT ?4, ?1, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13, ?15 ' +
        `WHERE (${SUBMITTED_TODAY_SQL}) < ?14 AND NOT EXISTS (SELECT 1 FROM limits ` +
        'WHERE user_id = ?1 AND question_block_until > ?10)' +
        (passed ? ` AND ${ROUND_OPEN_FOR_QUESTION}` : ''),
    )
    .bind(...args);
  const read = db.prepare(`${QUESTION_SELECT} WHERE q.id = ?1`).bind(q.id);
  const statements = [insert];
  if (passed) {
    statements.push(
      db
        .prepare(
          "UPDATE rounds SET question_id = ?2 WHERE id = ?1 AND locked_at IS NULL AND status = 'scheduled' " +
            'AND EXISTS (SELECT 1 FROM questions WHERE id = ?2)',
        )
        .bind(q.roundId, q.id),
    );
  }
  if (rejected) statements.push(blockAfterRejection(db, q.authorId, q.t));
  statements.push(read);
  const results = await db.batch<QuestionWithAuthorRow>(statements);
  return results[results.length - 1]?.results[0] ?? null;
}

export async function setRoomQuestion(
  c: Ctx,
  roomId: string,
  userId: string,
  body: SetRoomQuestionRequest,
): Promise<SetRoomQuestionResponse> {
  const db = c.env.DB;
  const t = now(c.env);
  const room = await memberRoom(db, roomId, userId);
  if (room.owner_user_id !== userId) {
    throw new HttpError('forbidden', "Only the room's owner can set its question");
  }
  if (room.question_source !== 'custom') {
    throw new HttpError('conflict', 'This room plays the daily question');
  }
  const input = cleanQuestionInput(body);
  refuseOverQuota(c, await quotaOf(db, userId, t), t);

  await insertRoomRoundsAhead(db, roomId, t);
  const roundId = await targetRound(db, roomId, t);
  if (!roundId) {
    throw new HttpError('conflict', "The next room round's question lock has passed");
  }

  const result = roomModeration(await moderateQuestion(c.env, input, t));
  const id = newUlid(t);
  const storeAt = now(c.env);
  const row = await store(db, { id, authorId: userId, roomId, roundId, t, storeAt }, input, result);
  if (!row) {
    refuseOverQuota(c, await quotaOf(db, userId, t), t);
    if (result.decision === 'pass') {
      throw new HttpError('conflict', "The room round's question lock has passed");
    }
    throw new HttpError('rate_limited', 'Too many submissions; try again later');
  }
  log.info('room_question_submitted', {
    roomId,
    roundId,
    questionId: id,
    decision: result.decision,
  });
  return {
    question: questionView(row, questionAuthor(row), t),
    moderation: {
      outcome: OUTCOMES[result.decision],
      reason: result.decision === 'reject' ? row.rejection_reason : null,
    },
    roundId,
  };
}
