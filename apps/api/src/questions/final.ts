// After a daily round's mode is final (spec "Question pipeline" step 5 and "Profiles, leaderboards and
// rooms" › Creators board; "Notifications" `question_used`): the question's split quality for that
// mode, and the author's `question_used` (stage `settled`) notice. W8-D registers
// `onQuestionModeFinal` through W8-B's `onModeFinal(handler)` (src/settlement/hooks.ts), which Free
// apply calls when a mode settles or refunds and the Stakes indexer calls at `RoundFinalized`.
//
// It pays nothing. The Free creator award is credited by Free apply itself (src/settlement/apply/
// free.ts `creditsOf`: only when the outcome is `settled`, to the locked `awardRecipient`, under the
// ledger key (user, scope, 'creator_award', roundId), so once). The Stakes creator fee is paid
// onchain to the `creator` frozen at lock when the round finalizes (FlockedEscrow `_finalize`); a
// refunded round credits no one.
//
// Idempotent: a retried settlement or a re-processed chain event calls it again. The split row is
// written once per (round, mode) (ON CONFLICT DO NOTHING); the notice is enqueued on every call that
// finds a settled mode, under the stable key `question_used:{questionId}:settled` (one per question,
// whichever mode settles first), which the consumer delivers once. A permanent condition (not a
// daily round, not settled, a bad tally) returns without writing; a D1 failure throws, for a retry.
import { TallySchema, type Mode, type ModeStatus, type RoundKind } from '@flocked/shared';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import { log } from '../lib/log.js';
import { enqueueQuestionNotice, questionUsedMessage } from './notify.js';

export type QuestionFinalEnv = Pick<
  Env,
  'DB' | 'QUEUE_NOTIFY' | 'ENVIRONMENT' | 'FLOCKED_TEST_CLOCK'
>;

/** What `onModeFinal` hands the handler: the round and the mode that became final. */
export interface ModeFinalEvent {
  roundId: string;
  mode: Mode;
}

/**
 * splitQuality = 1 − (maxShare − 0.5) / 0.5 over the valid headcounts (VOIDs excluded), which is
 * 2 · minShare: 1.0 for an even split, 0.8 for 60/40. Computed as 2·min/total so that exact splits
 * give exact values.
 */
export function splitQuality(n0: number, n1: number): number {
  const total = n0 + n1;
  if (!Number.isSafeInteger(n0) || !Number.isSafeInteger(n1) || n0 < 0 || n1 < 0 || total === 0) {
    throw new RangeError(`no split for headcounts ${n0} and ${n1}`);
  }
  return (2 * Math.min(n0, n1)) / total;
}

interface FinalRow {
  kind: RoundKind;
  question_id: string | null;
  author_user_id: string | null;
  mode_status: ModeStatus;
  outcome: string | null;
  tally_json: string | null;
}

/** Records the split quality of a settled daily mode and tells the author. See the header. */
export async function onQuestionModeFinal(
  env: QuestionFinalEnv,
  event: ModeFinalEvent,
): Promise<void> {
  const { roundId, mode } = event;
  const db = env.DB;
  // The current settlement record (a vetoed proposal is superseded). For Stakes the record says
  // `settled` from the proposal on, so a refunded or voided mode is excluded by its status too.
  const row = await db
    .prepare(
      `SELECT r.kind, r.question_id, q.author_user_id, m.status AS mode_status, s.outcome, s.tally_json
       FROM rounds r
       JOIN round_modes m ON m.round_id = r.id AND m.mode = ?2
       LEFT JOIN questions q ON q.id = r.question_id
       LEFT JOIN settlements s ON s.round_id = r.id AND s.mode = ?2 AND s.superseded_at IS NULL
       WHERE r.id = ?1`,
    )
    .bind(roundId, mode)
    .first<FinalRow>();
  if (!row) {
    log.warn('question_final_unknown_mode', { roundId, mode });
    return;
  }
  if (row.kind !== 'daily') return;
  if (row.outcome !== 'settled' || row.mode_status === 'refunded' || row.mode_status === 'voided') {
    return;
  }
  if (row.question_id === null) {
    log.error('question_final_no_question', { roundId, mode });
    return;
  }

  const tally = TallySchema.safeParse(row.tally_json === null ? null : JSON.parse(row.tally_json));
  const n0 = tally.success ? tally.data[0].headcount : 0;
  const n1 = tally.success ? tally.data[1].headcount : 0;
  if (!tally.success || n0 + n1 === 0) {
    log.error('question_final_bad_tally', { roundId, mode, tally: row.tally_json });
    return;
  }
  const quality = splitQuality(n0, n1);
  const res = await db
    .prepare(
      `INSERT INTO question_splits (round_id, mode, question_id, split_quality, entrants, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`,
    )
    .bind(roundId, mode, row.question_id, quality, n0 + n1, now(env))
    .run();
  log.info('question_split_recorded', {
    roundId,
    mode,
    questionId: row.question_id,
    splitQuality: quality,
    entrants: n0 + n1,
    inserted: res.meta.changes === 1,
  });

  if (row.author_user_id !== null) {
    await enqueueQuestionNotice(
      env,
      questionUsedMessage(row.author_user_id, row.question_id, roundId, 'settled'),
    );
  }
}
