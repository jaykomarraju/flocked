// Moderation types (spec "Question pipeline" step 2). `moderateQuestion` (./index.ts) runs the model
// verdict and the duplicate lookup and decides: pass (the vote queue), reject (with a reason shown to
// the author) or review (an admin decides: a refusal, a failed call, or a failed duplicate lookup).
import type { Category } from '@flocked/shared';
import type { Env } from '../env.js';

/** The model the rubric runs on (spec). */
export const MODERATION_MODEL = 'claude-sonnet-5-5';
/** Near-duplicate threshold: cosine similarity of the prompt embeddings (spec). */
export const DUPLICATE_MIN_SCORE = 0.9;
/** Duplicates are looked for among questions created in the last 365 days (spec). */
export const DUPLICATE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/** A question as moderation sees it (already format-valid). */
export interface ModerationInput {
  prompt: string;
  options: readonly [{ label: string; emoji?: string }, { label: string; emoji?: string }];
  category: Category;
}

/** The structured output the rubric asks the model for (`output_config.format`). */
export interface ModelOutput {
  safe: boolean;
  twoSided: boolean;
  preferenceBased: boolean;
  /** The larger option's predicted share of people, 0.5–1.0. */
  predictedSplit: number;
  /** One short sentence for the author when a check fails; empty when all pass. */
  reason: string;
}

/** What one model call returned. A refusal and an error both send the question to admin review. */
export type ModelVerdict =
  | { kind: 'verdict'; output: ModelOutput; stopReason: string | null }
  | { kind: 'refusal'; category: string | null }
  | { kind: 'error'; error: string };

/** The rubric model. Declared as a property function type (unbound-method lint). */
export interface ModerationModel {
  classify: (input: ModerationInput) => Promise<ModelVerdict>;
}

/** A near-duplicate hit. */
export interface DuplicateHit {
  id: string;
  score: number;
}

/** Embedding similarity over recent questions (Workers AI embeddings + Vectorize in production). */
export interface DuplicateIndex {
  /** The most similar question created at or after `since` with a score ≥ `minScore`, or null. Rejects on failure. */
  findDuplicate: (
    text: string,
    opts: { since: number; minScore: number },
  ) => Promise<DuplicateHit | null>;
  /** Adds a question to the index. Rejects on failure. */
  add: (q: { id: string; text: string; createdAt: number }) => Promise<void>;
}

export type ModerationDecision = 'pass' | 'reject' | 'review';

/** Why a question went to review. */
export type ReviewCause = 'refusal' | 'model_error' | 'invalid_output' | 'duplicate_lookup_failed';

/** `questions.moderation_json`: the model's full JSON plus what the pipeline added. */
export interface ModerationJson {
  version: 1;
  model: string;
  decision: ModerationDecision;
  /** The author-facing reason when rejected; null otherwise. */
  reason: string | null;
  /** The model's output, or null when it refused or failed. */
  output: ModelOutput | null;
  /** The larger option's predicted share (0.5–1.0), or null without a verdict. */
  predictedSplit: number | null;
  duplicateOf: string | null;
  duplicateScore: number | null;
  /** Set when decision is review. */
  reviewCause: ReviewCause | null;
  /** The refusal's category, or the error message (never secrets), when there is one. */
  detail: string | null;
  checkedAt: number;
}

export interface ModerationResult {
  decision: ModerationDecision;
  reason: string | null;
  predictedSplit: number | null;
  duplicateOf: string | null;
  json: ModerationJson;
}

/** What moderation reads from the env. `ANTHROPIC_*` are not in src/env.ts yet (Notes for D). */
export type ModerationEnv = Pick<Env, 'ENVIRONMENT' | 'DB' | 'AI' | 'VECTORIZE'> & {
  /** Workers secret (`.dev.vars` locally). */
  ANTHROPIC_API_KEY?: string;
  /** API origin override (e2e/mocks/anthropic); honoured only when ENVIRONMENT is 'local'. */
  ANTHROPIC_BASE_URL?: string;
};

/** Injected dependencies; tests register fakes with `withModerationDeps` (./deps.ts). */
export interface ModerationDeps {
  model: ModerationModel;
  duplicates: DuplicateIndex;
}
