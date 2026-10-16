// Moderation entry points (spec "Question pipeline" step 2). PINNED SIGNATURES: W8-A's moderation
// builder replaces these bodies; routes and admin code call only these two functions.
import type { ModerationEnv, ModerationInput, ModerationResult } from './types.js';

export * from './types.js';

/**
 * Moderates one question: the rubric model and the duplicate lookup, then the decision table.
 * Never throws for a model or index failure (those decide `review`).
 */
export async function moderateQuestion(
  _env: ModerationEnv,
  _input: ModerationInput,
  _t: number,
): Promise<ModerationResult> {
  await Promise.resolve();
  throw new Error('moderateQuestion: not built yet');
}

/**
 * Adds a stored question to the duplicate index (after its D1 insert). Never throws: a failure is
 * logged, and the question is simply not found as a duplicate later.
 */
export async function indexQuestion(
  _env: ModerationEnv,
  _q: { id: string; prompt: string; createdAt: number },
): Promise<void> {
  await Promise.resolve();
  throw new Error('indexQuestion: not built yet');
}
