// The admin console's question-queue actions (spec "Admin console" › Question queue and Schedule;
// "Question pipeline" step 4 and House questions; decision E4, Oct 12, 2026), as functions W11-A
// wires into routes/admin.ts:
//   - approve: `submitted → queued` (a pending review is cleared);
//   - reject with a reason: `submitted | queued → rejected`, the 7-day block check, and
//     `question_rejected` to the author. A scheduled question is unassigned first (assign another
//     question to its day: it goes back to `queued`); a used one is locked;
//   - assign: a `queued` question to a game day's daily round before its question lock (the round
//     is created if the scheduler hasn't yet); the question it replaces goes back to `queued`; then
//     the house backlog check;
//   - edit the wording or category before lock, with a reason: `question_edited` to the author, and
//     the duplicate index is updated;
//   - add a house question: `queued`, no author. Admins are trusted: no moderation.
// Each writes its change and one `audit_log` row (actor `admin`) in one D1 batch. The batch opens
// with a guard on the state the action was decided from (`abortIf`), so a concurrent change rolls it
// back and answers `conflict` (or `question_locked`) instead of writing over it. Notices are built
// (validated) before the batch and sent after it; a send failure is logged (./notify.ts).
import {
  QuestionInputSchema,
  isGameDay,
  newUlid,
  type AddHouseQuestionRequest,
  type AddHouseQuestionResponse,
  type AdminQuestion,
  type AdminQuestionActionResponse,
  type AssignQuestionResponse,
  type Category,
  type EditQuestionRequest,
  type NotifyMessage,
  type QuestionInput,
  type QuestionOptionInput,
} from '@flocked/shared';
import type { Env } from '../env.js';
import { abortIf, isGuardAbort } from '../identity/sql.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { indexQuestion, type ModerationEnv, type ModerationInput } from '../moderation/index.js';
import { dailySlot, insertDailyRound } from '../scheduler/create.js';
import { LOCK_LEAD_MS } from '../scheduler/lock.js';
import { checkHouseBacklog } from './backlog.js';
import { cleanQuestionInput, storedOptionsJson } from './format.js';
import { enqueueQuestionNotice, questionEditedMessage, questionRejectedMessage } from './notify.js';
import { blockAfterRejection } from './quota.js';
import {
  QUESTION_SELECT,
  parseOptions,
  questionAuthor,
  questionView,
  type QuestionWithAuthorRow,
} from './rows.js';

export type QuestionAdminEnv = Pick<Env, 'DB' | 'QUEUE_NOTIFY' | 'ANALYTICS' | 'ENVIRONMENT'> &
  ModerationEnv;

/** An admin's reason (shown to the author on a rejection): 1–500 characters after trimming. */
export const ADMIN_REASON_MAX = 500;

const SELECT_ONE = `${QUESTION_SELECT} WHERE q.id = ?1`;

/** `moderation_json` as the console shows it, and its predicted split (0.5–1), when stored. */
function moderationOf(json: string | null): {
  moderation: Record<string, unknown> | null;
  predictedSplit: number | null;
} {
  if (json === null) return { moderation: null, predictedSplit: null };
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { moderation: null, predictedSplit: null };
  }
  const moderation = parsed as Record<string, unknown>;
  const split = moderation.predictedSplit;
  const predictedSplit = typeof split === 'number' && split >= 0 && split <= 1 ? split : null;
  return { moderation, predictedSplit };
}

/** A question as the console shows it (`AdminQuestion`): the wire question plus its moderation. */
export function adminQuestionView(row: QuestionWithAuthorRow, t: number): AdminQuestion {
  return { ...questionView(row, questionAuthor(row), t), ...moderationOf(row.moderation_json) };
}

async function loadQuestion(db: D1Database, id: string): Promise<QuestionWithAuthorRow> {
  const row = await db.prepare(SELECT_ONE).bind(id).first<QuestionWithAuthorRow>();
  if (!row) throw new HttpError('not_found', 'No such question');
  return row;
}

/** One `audit_log` row by the admin, and its ID. */
function auditRow(
  db: D1Database,
  adminUserId: string,
  action: string,
  target: string,
  data: Record<string, unknown>,
  t: number,
): { id: string; stmt: D1PreparedStatement } {
  const id = newUlid(t);
  const stmt = db
    .prepare(
      'INSERT INTO audit_log (id, actor, actor_user_id, action, target, data_json, created_at) ' +
        "VALUES (?1, 'admin', ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(id, adminUserId, action, target, JSON.stringify(data), t);
  return { id, stmt };
}

/** The guard: abort unless the question is still in `status` (and unchanged where `same` says). */
function unchangedGuard(db: D1Database, row: QuestionWithAuthorRow, same = false) {
  const wording = same ? ' AND prompt = ?3 AND options_json = ?4 AND category = ?5' : '';
  return abortIf(
    db,
    `NOT EXISTS (SELECT 1 FROM questions WHERE id = ?1 AND status = ?2${wording})`,
    ...(same
      ? [row.id, row.status, row.prompt, row.options_json, row.category]
      : [row.id, row.status]),
  );
}

/**
 * Runs an action's batch (guard first, the re-read of the question last) and returns that row.
 * A guard abort re-reads the question and refuses with `refuse` (or a plain `conflict`).
 */
async function runBatch(
  db: D1Database,
  questionId: string,
  stmts: D1PreparedStatement[],
  refuse: (row: QuestionWithAuthorRow) => void | Promise<void>,
): Promise<QuestionWithAuthorRow> {
  let results: D1Result<QuestionWithAuthorRow>[];
  try {
    results = await db.batch<QuestionWithAuthorRow>([
      ...stmts,
      db.prepare(SELECT_ONE).bind(questionId),
    ]);
  } catch (err) {
    if (!isGuardAbort(err)) throw err;
    await refuse(await loadQuestion(db, questionId));
    throw new HttpError('conflict', 'The question changed meanwhile; reload it and try again');
  }
  const row = results[results.length - 1]?.results[0];
  if (!row) throw new HttpError('not_found', 'No such question');
  return row;
}

/**
 * A question checked with the submission format rules: `QuestionInputSchema` (lengths, the category
 * list, options that differ), then ./format.ts (trimmed and NFC, plain text, a single emoji). The
 * routes validate their request schemas first; this keeps the functions safe for any caller.
 */
function formatChecked(input: QuestionInput): ModerationInput {
  const parsed = QuestionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError('bad_request', parsed.error.issues[0]?.message ?? 'Invalid question');
  }
  return cleanQuestionInput(parsed.data);
}

/** A required admin reason, trimmed (400 `bad_request` when empty or over 500 characters). */
function reasonOf(raw: string): string {
  const reason = raw.trim();
  if (reason.length === 0 || reason.length > ADMIN_REASON_MAX) {
    throw new HttpError('bad_request', `The reason must be 1 to ${ADMIN_REASON_MAX} characters`);
  }
  return reason;
}

// Approve -----------------------------------------------------------------------------------------

/**
 * A room's question stays private: Approve and Assign would put it in the public queue or a daily
 * round, and Edit in the duplicate index.
 */
function refuseRoomQuestion(row: QuestionWithAuthorRow): void {
  if (row.room_id !== null) {
    throw new HttpError('conflict', "A room's question stays in its room");
  }
}

function refuseApprove(row: QuestionWithAuthorRow): void {
  refuseRoomQuestion(row);
  if (row.status !== 'submitted') {
    throw new HttpError(
      'conflict',
      `Only a submitted question can be approved; this one is ${row.status}`,
    );
  }
}

/** Approve: `submitted → queued`, clearing a pending review. Anything else is `conflict`. */
export async function approveQuestion(
  env: QuestionAdminEnv,
  adminUserId: string,
  questionId: string,
  t: number,
): Promise<AdminQuestionActionResponse> {
  const db = env.DB;
  const row = await loadQuestion(db, questionId);
  refuseApprove(row);
  const audit = auditRow(
    db,
    adminUserId,
    'question_approve',
    questionId,
    { from: row.status, needsReview: row.needs_review === 1 },
    t,
  );
  const after = await runBatch(
    db,
    questionId,
    [
      unchangedGuard(db, row),
      db
        .prepare(
          "UPDATE questions SET status = 'queued', needs_review = 0 WHERE id = ?1 AND status = 'submitted'",
        )
        .bind(questionId),
      audit.stmt,
    ],
    refuseApprove,
  );
  log.info('question_approved', { questionId, adminUserId, auditId: audit.id });
  return { question: adminQuestionView(after, t), auditId: audit.id };
}

// Reject ------------------------------------------------------------------------------------------

function refuseReject(row: QuestionWithAuthorRow): void {
  if (row.status === 'submitted' || row.status === 'queued') return;
  if (row.status === 'used') {
    throw new HttpError('question_locked', 'This question was used at question lock');
  }
  if (row.status === 'scheduled') {
    throw new HttpError(
      'conflict',
      'This question is scheduled; assign another question to its day before rejecting it',
    );
  }
  throw new HttpError('conflict', `This question is ${row.status} already`);
}

/**
 * Reject with a reason: `submitted | queued → rejected`, then the 7-day submission block check for
 * the author (a moderation or admin rejection counts alike), and `question_rejected` with the reason.
 */
export async function rejectQuestion(
  env: QuestionAdminEnv,
  adminUserId: string,
  questionId: string,
  rawReason: string,
  t: number,
): Promise<AdminQuestionActionResponse> {
  const db = env.DB;
  const reason = reasonOf(rawReason);
  const row = await loadQuestion(db, questionId);
  refuseReject(row);
  const author = row.author_user_id;
  const notice = author === null ? null : questionRejectedMessage(author, questionId, reason);
  const audit = auditRow(
    db,
    adminUserId,
    'question_reject',
    questionId,
    { from: row.status, reason },
    t,
  );
  const after = await runBatch(
    db,
    questionId,
    [
      unchangedGuard(db, row),
      db
        .prepare(
          "UPDATE questions SET status = 'rejected', needs_review = 0, rejection_reason = ?2, rejected_at = ?3 " +
            "WHERE id = ?1 AND status IN ('submitted', 'queued')",
        )
        .bind(questionId, reason, t),
      audit.stmt,
      // After the rejection, so its count includes this one.
      ...(author === null ? [] : [blockAfterRejection(db, author, t)]),
    ],
    refuseReject,
  );
  log.info('question_rejected', { questionId, adminUserId, auditId: audit.id });
  if (notice) await enqueueQuestionNotice(env, notice);
  return { question: adminQuestionView(after, t), auditId: audit.id };
}

// Assign ------------------------------------------------------------------------------------------

function refuseAssign(row: QuestionWithAuthorRow): void {
  refuseRoomQuestion(row);
  if (row.status !== 'queued') {
    throw new HttpError(
      'conflict',
      `Only an approved (queued) question can be assigned; this one is ${row.status}`,
    );
  }
}

interface DailyRoundRow {
  id: string;
  question_id: string | null;
  locked_at: number | null;
  status: string;
}

/**
 * Assign a `queued` question to `gameDay`'s daily round, before its question lock (opensAt − 6 h;
 * a past day is past it): the question becomes `scheduled`, the round points at it, and a question
 * assigned before goes back to `queued`. The round is created when the scheduler hasn't yet (it
 * creates rounds 48 h ahead). A locked round, or a day past its lock, is `question_locked`. Then
 * the house backlog check (assigning a house question takes it out of the backlog).
 */
export async function assignQuestion(
  env: QuestionAdminEnv,
  adminUserId: string,
  gameDay: string,
  questionId: string,
  t: number,
): Promise<AssignQuestionResponse> {
  const db = env.DB;
  if (!isGameDay(gameDay)) throw new HttpError('bad_request', 'Not a game day');
  const slot = dailySlot(gameDay);
  if (t >= slot.opensAt - LOCK_LEAD_MS) {
    throw new HttpError('question_locked', `The question lock for ${gameDay} has passed`);
  }
  const row = await loadQuestion(db, questionId);
  refuseAssign(row);

  const selectRound = db
    .prepare(
      "SELECT id, question_id, locked_at, status FROM rounds WHERE kind = 'daily' AND closes_at = ?1",
    )
    .bind(slot.closesAt);
  let round = await selectRound.first<DailyRoundRow>();
  if (!round) {
    await insertDailyRound(db, slot);
    round = await selectRound.first<DailyRoundRow>();
    if (!round) throw new Error(`the daily round of ${gameDay} was not created`);
  }
  // Locked, or closed unlocked as a no-round day (W8-F1 L1: never a question on no round).
  if (round.locked_at !== null || round.status !== 'scheduled') {
    throw new HttpError('question_locked', `The round of ${gameDay} is locked`);
  }
  const replaced = round.question_id !== questionId ? round.question_id : null;

  const audit = auditRow(
    db,
    adminUserId,
    'question_assign',
    questionId,
    { gameDay, roundId: round.id, replaced },
    t,
  );
  try {
    await db.batch([
      unchangedGuard(db, row),
      // The round is still unlocked and scheduled, and points where it did when this was decided.
      abortIf(
        db,
        "NOT EXISTS (SELECT 1 FROM rounds WHERE id = ?1 AND locked_at IS NULL AND status = 'scheduled' AND question_id IS ?2)",
        round.id,
        round.question_id,
      ),
      ...(replaced === null
        ? []
        : [
            db
              .prepare(
                "UPDATE questions SET status = 'queued' WHERE id = ?1 AND status = 'scheduled'",
              )
              .bind(replaced),
          ]),
      db
        .prepare("UPDATE questions SET status = 'scheduled' WHERE id = ?1 AND status = 'queued'")
        .bind(questionId),
      db
        .prepare('UPDATE rounds SET question_id = ?2 WHERE id = ?1 AND locked_at IS NULL')
        .bind(round.id, questionId),
      audit.stmt,
    ]);
  } catch (err) {
    if (!isGuardAbort(err)) throw err;
    refuseAssign(await loadQuestion(db, questionId));
    const current = await selectRound.first<DailyRoundRow>();
    if (current && (current.locked_at !== null || current.status !== 'scheduled')) {
      throw new HttpError('question_locked', `The round of ${gameDay} is locked`);
    }
    throw new HttpError('conflict', 'The schedule changed meanwhile; reload it and try again');
  }
  log.info('question_assigned', {
    questionId,
    gameDay,
    roundId: round.id,
    replaced,
    adminUserId,
    auditId: audit.id,
  });

  try {
    await checkHouseBacklog(env, t);
  } catch (err) {
    log.error('house_backlog_check_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { gameDay, roundId: round.id, questionId, auditId: audit.id };
}

// Edit --------------------------------------------------------------------------------------------

function refuseEdit(row: QuestionWithAuthorRow): void {
  // A room question is never indexed, and an edit would re-index it (W8-F1 L2).
  refuseRoomQuestion(row);
  if (row.status === 'used') {
    throw new HttpError('question_locked', 'This question was used at question lock');
  }
  if (row.status === 'rejected') {
    throw new HttpError('conflict', 'A rejected question cannot be edited');
  }
}

/** The stored options as submitted input (`emoji` "" is none). */
function optionsInput(row: QuestionWithAuthorRow): [QuestionOptionInput, QuestionOptionInput] {
  const [a, b] = parseOptions(row);
  const input = (o: { label: string; emoji: string }): QuestionOptionInput =>
    o.emoji === '' ? { label: o.label } : { label: o.label, emoji: o.emoji };
  return [input(a), input(b)];
}

/**
 * Edit the prompt, options or category of a question before lock (a used question is
 * `question_locked`; a rejected one `conflict`), with a reason. The result is checked with the
 * submission format rules (./format.ts: lengths, options that differ, single emoji). The author gets
 * `question_edited` keyed by the audit row, and the duplicate index gets the new wording.
 */
export async function editQuestion(
  env: QuestionAdminEnv,
  adminUserId: string,
  questionId: string,
  patch: EditQuestionRequest,
  t: number,
): Promise<AdminQuestionActionResponse> {
  const db = env.DB;
  const reason = reasonOf(patch.reason);
  const row = await loadQuestion(db, questionId);
  refuseEdit(row);

  const edited = formatChecked({
    prompt: patch.prompt ?? row.prompt,
    options: patch.options ?? optionsInput(row),
    category: patch.category ?? (row.category as Category),
  });
  const before = { prompt: row.prompt, options: parseOptions(row), category: row.category };
  const optionsJson = storedOptionsJson(edited.options);
  const after = {
    prompt: edited.prompt,
    options: JSON.parse(optionsJson) as unknown,
    category: edited.category,
  };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (after.prompt !== before.prompt) changes.prompt = { from: before.prompt, to: after.prompt };
  if (optionsJson !== JSON.stringify(before.options)) {
    changes.options = { from: before.options, to: after.options };
  }
  if (after.category !== before.category) {
    changes.category = { from: before.category, to: after.category };
  }
  if (Object.keys(changes).length === 0) {
    throw new HttpError('bad_request', 'The edit changes nothing');
  }

  const audit = auditRow(db, adminUserId, 'question_edit', questionId, { reason, changes }, t);
  const author = row.author_user_id;
  const notice: NotifyMessage | null =
    author === null ? null : questionEditedMessage(author, questionId, audit.id);
  const refuse = async (current: QuestionWithAuthorRow) => {
    refuseEdit(current);
    const locked = await db
      .prepare('SELECT 1 FROM rounds WHERE question_id = ?1 AND locked_at IS NOT NULL LIMIT 1')
      .bind(questionId)
      .first();
    if (locked) throw new HttpError('question_locked', 'This question was used at question lock');
  };
  const updated = await runBatch(
    db,
    questionId,
    [
      unchangedGuard(db, row, true),
      // Never after lock, whatever the status says.
      abortIf(
        db,
        'EXISTS (SELECT 1 FROM rounds WHERE question_id = ?1 AND locked_at IS NOT NULL)',
        questionId,
      ),
      db
        .prepare(
          'UPDATE questions SET prompt = ?2, options_json = ?3, category = ?4 ' +
            "WHERE id = ?1 AND status IN ('submitted', 'queued', 'scheduled')",
        )
        .bind(questionId, edited.prompt, optionsJson, edited.category),
      audit.stmt,
    ],
    refuse,
  );
  log.info('question_edited', {
    questionId,
    fields: Object.keys(changes),
    adminUserId,
    auditId: audit.id,
  });
  if (notice) await enqueueQuestionNotice(env, notice);
  if (changes.prompt || changes.options) {
    await indexQuestion(env, {
      id: questionId,
      prompt: edited.prompt,
      createdAt: row.created_at,
      options: edited.options,
    });
  }
  return { question: adminQuestionView(updated, t), auditId: audit.id };
}

// House questions ---------------------------------------------------------------------------------

/**
 * Add a house question: `queued` with no author, so it joins the backlog the scheduler fills gaps
 * from. Checked with the submission format rules, not moderated (admins are trusted), and added to
 * the duplicate index so a user's near-copy of it is rejected.
 */
export async function addHouseQuestion(
  env: QuestionAdminEnv,
  adminUserId: string,
  input: AddHouseQuestionRequest,
  t: number,
): Promise<AddHouseQuestionResponse> {
  const db = env.DB;
  const q = formatChecked(input);
  const id = newUlid(t);
  const optionsJson = storedOptionsJson(q.options);
  const audit = auditRow(
    db,
    adminUserId,
    'question_add_house',
    id,
    { prompt: q.prompt, options: JSON.parse(optionsJson) as unknown, category: q.category },
    t,
  );
  const results = await db.batch<QuestionWithAuthorRow>([
    db
      .prepare(
        'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, score, created_at) ' +
          "VALUES (?1, NULL, ?2, ?3, ?4, 'queued', 0, ?5)",
      )
      .bind(id, q.prompt, optionsJson, q.category, t),
    audit.stmt,
    db.prepare(SELECT_ONE).bind(id),
  ]);
  const row = results[results.length - 1]?.results[0];
  if (!row) throw new Error(`house question ${id} was not stored`);
  log.info('house_question_added', { questionId: id, adminUserId, auditId: audit.id });
  await indexQuestion(env, { id, prompt: q.prompt, createdAt: t, options: q.options });
  return { question: adminQuestionView(row, t), auditId: audit.id };
}
