// Moderation entry points (spec "Question pipeline" step 2). PINNED SIGNATURES: routes and admin
// code call only these two functions. The rubric model and the duplicate index come from
// `moderationDeps(env)` (./deps.ts; tests register fakes), the decision from ./decide.ts.
import { z } from 'zod';
import { log } from '../lib/log.js';
import { decide, type DuplicateLookup } from './decide.js';
import { moderationDeps } from './deps.js';
import { duplicateText } from './duplicates.js';
import {
  DUPLICATE_MIN_SCORE,
  DUPLICATE_WINDOW_MS,
  type DuplicateIndex,
  type ModelVerdict,
  type ModerationEnv,
  type ModerationInput,
  type ModerationModel,
  type ModerationResult,
} from './types.js';

export * from './types.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
}

async function classify(model: ModerationModel, input: ModerationInput): Promise<ModelVerdict> {
  try {
    return await model.classify(input);
  } catch (err) {
    // The real model never throws; this keeps a broken one from failing the submit.
    return { kind: 'error', error: errorMessage(err) };
  }
}

async function lookUp(index: DuplicateIndex, text: string, t: number): Promise<DuplicateLookup> {
  try {
    const hit = await index.findDuplicate(text, {
      since: t - DUPLICATE_WINDOW_MS,
      minScore: DUPLICATE_MIN_SCORE,
    });
    return hit ? { kind: 'found', hit } : { kind: 'none' };
  } catch (err) {
    const error = errorMessage(err);
    log.warn('moderation.duplicate_lookup_failed', { error });
    return { kind: 'failed', error };
  }
}

/**
 * Moderates one question: the rubric model and the duplicate lookup (concurrently), then the
 * decision table. Never throws for a model or index failure (those decide `review`).
 */
export async function moderateQuestion(
  env: ModerationEnv,
  input: ModerationInput,
  t: number,
): Promise<ModerationResult> {
  const deps = moderationDeps(env);
  const [verdict, lookup] = await Promise.all([
    classify(deps.model, input),
    lookUp(deps.duplicates, duplicateText(input.prompt, input.options), t),
  ]);
  const result = decide(verdict, lookup, t);
  log.info('moderation.decided', {
    decision: result.decision,
    reviewCause: result.json.reviewCause,
    duplicateOf: result.duplicateOf,
    predictedSplit: result.predictedSplit,
  });
  return result;
}

const StoredOptionsSchema = z.array(z.object({ label: z.string() })).length(2);

/**
 * Adds a stored question to the duplicate index (after its D1 insert). The indexed text is the
 * prompt with both option labels: pass `options`, or they are read from the question's D1 row.
 * Never throws: a failure is logged, and the question is simply not found as a duplicate later.
 */
export async function indexQuestion(
  env: ModerationEnv,
  q: { id: string; prompt: string; createdAt: number; options?: readonly { label: string }[] },
): Promise<void> {
  try {
    let options = q.options;
    if (!options) {
      const row = await env.DB.prepare('SELECT options_json FROM questions WHERE id = ?1')
        .bind(q.id)
        .first<{ options_json: string }>();
      if (!row) {
        log.warn('moderation.index_skipped', { questionId: q.id, error: 'no such question' });
        return;
      }
      options = StoredOptionsSchema.parse(JSON.parse(row.options_json));
    }
    const text = duplicateText(q.prompt, options);
    await moderationDeps(env).duplicates.add({ id: q.id, text, createdAt: q.createdAt });
  } catch (err) {
    log.warn('moderation.index_failed', { questionId: q.id, error: errorMessage(err) });
  }
}
