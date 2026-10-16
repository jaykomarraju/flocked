// The moderation decision table (spec "Question pipeline" step 2; W8-A brief). Pure: the model's
// verdict and the duplicate lookup in, the decision and `questions.moderation_json` out.
//
// With a valid verdict:
//   1. a failed check (safe, twoSided, preferenceBased) → reject with the model's reason, or the
//      fixed sentence for the first failed check when the model gave none;
//   2. else a confirmed duplicate → reject with the fixed duplicate reason;
//   3. else a failed duplicate lookup → review (`duplicate_lookup_failed`);
//   4. else pass.
// Without one (a refusal, a failed call, output that did not parse or validate) → review, even
// when a duplicate was found: the spec sends these to an admin instead of rejecting automatically.
import { ModelOutputSchema } from './claude.js';
import {
  MODERATION_MODEL,
  type DuplicateHit,
  type ModelOutput,
  type ModelVerdict,
  type ModerationJson,
  type ModerationResult,
  type ReviewCause,
} from './types.js';

/** What the duplicate lookup found. A failure never throws past moderateQuestion. */
export type DuplicateLookup =
  { kind: 'found'; hit: DuplicateHit } | { kind: 'none' } | { kind: 'failed'; error: string };

type Check = 'safe' | 'twoSided' | 'preferenceBased';

/** The author-facing reasons used when the model gave none, and for a duplicate. */
export const FALLBACK_REASONS = {
  safe: "This question isn't allowed. Keep it friendly and about everyday choices.",
  twoSided: 'One option is the obvious pick. Make both options something people would choose.',
  preferenceBased: 'This has a correct answer. Ask about a preference instead.',
  duplicate: 'This is very close to a question we already have.',
} as const satisfies Record<Check | 'duplicate', string>;

const CHECKS: readonly Check[] = ['safe', 'twoSided', 'preferenceBased'];

function firstFailedCheck(output: ModelOutput): Check | null {
  return CHECKS.find((c) => !output[c]) ?? null;
}

/** Decides one question from the model's verdict and the duplicate lookup, checked at `t`. */
export function decide(
  verdict: ModelVerdict,
  lookup: DuplicateLookup,
  t: number,
): ModerationResult {
  const duplicate = lookup.kind === 'found' ? lookup.hit : null;
  const result = (
    json: Pick<ModerationJson, 'decision' | 'reason' | 'output' | 'reviewCause' | 'detail'>,
  ): ModerationResult => {
    const full: ModerationJson = {
      version: 1,
      model: MODERATION_MODEL,
      decision: json.decision,
      reason: json.reason,
      output: json.output,
      predictedSplit: json.output?.predictedSplit ?? null,
      duplicateOf: duplicate?.id ?? null,
      duplicateScore: duplicate?.score ?? null,
      reviewCause: json.reviewCause,
      detail: json.detail,
      checkedAt: t,
    };
    return {
      decision: full.decision,
      reason: full.reason,
      predictedSplit: full.predictedSplit,
      duplicateOf: full.duplicateOf,
      json: full,
    };
  };
  const review = (cause: ReviewCause, detail: string | null, output: ModelOutput | null = null) =>
    result({ decision: 'review', reason: null, output, reviewCause: cause, detail });

  if (verdict.kind === 'refusal') return review('refusal', verdict.category);
  if (verdict.kind === 'error') {
    return review(verdict.invalidOutput ? 'invalid_output' : 'model_error', verdict.error);
  }
  const parsed = ModelOutputSchema.safeParse(verdict.output);
  if (!parsed.success) return review('invalid_output', 'output failed validation');
  const output = parsed.data;

  const failed = firstFailedCheck(output);
  if (failed) {
    const reason = output.reason.trim() || FALLBACK_REASONS[failed];
    return result({ decision: 'reject', reason, output, reviewCause: null, detail: null });
  }
  if (duplicate) {
    const reason = FALLBACK_REASONS.duplicate;
    return result({ decision: 'reject', reason, output, reviewCause: null, detail: null });
  }
  if (lookup.kind === 'failed') return review('duplicate_lookup_failed', lookup.error, output);
  return result({ decision: 'pass', reason: null, output, reviewCause: null, detail: null });
}
