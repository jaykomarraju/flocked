// The moderation decision table (spec "Question pipeline" step 2; src/moderation/decide.ts) through
// moderateQuestion, with a fake rubric model and a fake duplicate index registered on the env
// (withModerationDeps): pass, reject on a failed check or a duplicate, review on a refusal, a
// failed call, invalid output or a failed duplicate lookup; and what is stored in moderation_json.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_REASONS } from '../../src/moderation/decide.js';
import { withModerationDeps } from '../../src/moderation/deps.js';
import { duplicateText } from '../../src/moderation/duplicates.js';
import {
  DUPLICATE_WINDOW_MS,
  MODERATION_MODEL,
  indexQuestion,
  moderateQuestion,
  type ModelOutput,
  type ModelVerdict,
} from '../../src/moderation/index.js';
import {
  PASS_OUTPUT,
  QUESTION,
  T,
  fakeIndex,
  fakeModel,
  insertQuestions,
  moderationEnv,
  verdictOf,
} from './moderation-fakes.js';

const DUP = { id: '01K7DUP0000000000000000001', score: 0.93 };

function moderate(verdict: ModelVerdict | (() => Promise<ModelVerdict>), index = fakeIndex(null)) {
  const env = withModerationDeps(moderationEnv(), { model: fakeModel(verdict), duplicates: index });
  return moderateQuestion(env, QUESTION, T);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('moderateQuestion: with a verdict', () => {
  it('passes a question that passes every check and has no duplicate', async () => {
    const r = await moderate(verdictOf({ predictedSplit: 0.72 }));
    expect(r.decision).toBe('pass');
    expect(r.reason).toBeNull();
    expect(r.predictedSplit).toBe(0.72);
    expect(r.duplicateOf).toBeNull();
    expect(r.json).toEqual({
      version: 1,
      model: MODERATION_MODEL,
      decision: 'pass',
      reason: null,
      output: { ...PASS_OUTPUT, predictedSplit: 0.72 },
      predictedSplit: 0.72,
      duplicateOf: null,
      duplicateScore: null,
      reviewCause: null,
      detail: null,
      checkedAt: T,
    });
  });

  it.each(['safe', 'twoSided', 'preferenceBased'] as const)(
    'rejects when %s is false, with the model reason',
    async (check) => {
      const r = await moderate(verdictOf({ [check]: false, reason: '  Ask about a taste.  ' }));
      expect(r.decision).toBe('reject');
      expect(r.reason).toBe('Ask about a taste.');
      expect(r.json.reason).toBe('Ask about a taste.');
      expect(r.json.output?.[check]).toBe(false);
      expect(r.json.reviewCause).toBeNull();
    },
  );

  it.each(['safe', 'twoSided', 'preferenceBased'] as const)(
    'rejects when %s is false with the fixed reason when the model gave none',
    async (check) => {
      const r = await moderate(verdictOf({ [check]: false, reason: ' ' }));
      expect(r.decision).toBe('reject');
      expect(r.reason).toBe(FALLBACK_REASONS[check]);
    },
  );

  it('uses the first failed check for the fixed reason', async () => {
    const r = await moderate(verdictOf({ twoSided: false, preferenceBased: false, reason: '' }));
    expect(r.reason).toBe(FALLBACK_REASONS.twoSided);
  });

  it('rejects a duplicate with the fixed reason, recording the hit', async () => {
    const r = await moderate(verdictOf(), fakeIndex(DUP));
    expect(r.decision).toBe('reject');
    expect(r.reason).toBe(FALLBACK_REASONS.duplicate);
    expect(r.duplicateOf).toBe(DUP.id);
    expect(r.json).toMatchObject({
      decision: 'reject',
      reason: FALLBACK_REASONS.duplicate,
      duplicateOf: DUP.id,
      duplicateScore: DUP.score,
      predictedSplit: 0.6,
      reviewCause: null,
    });
  });

  it("a failed check's reason wins over a duplicate", async () => {
    const r = await moderate(verdictOf({ safe: false, reason: 'Keep it kind.' }), fakeIndex(DUP));
    expect(r.decision).toBe('reject');
    expect(r.reason).toBe('Keep it kind.');
    expect(r.json.duplicateOf).toBe(DUP.id);
  });

  it('sends a passing question to review when the duplicate lookup fails', async () => {
    const r = await moderate(verdictOf(), fakeIndex(null, new Error('vectorize down')));
    expect(r.decision).toBe('review');
    expect(r.reason).toBeNull();
    expect(r.json).toMatchObject({
      decision: 'review',
      reviewCause: 'duplicate_lookup_failed',
      detail: 'vectorize down',
      output: PASS_OUTPUT,
      predictedSplit: 0.6,
      duplicateOf: null,
    });
  });

  it('still rejects a failed check when the duplicate lookup fails', async () => {
    const r = await moderate(
      verdictOf({ preferenceBased: false, reason: 'This has an answer.' }),
      fakeIndex(null, new Error('vectorize down')),
    );
    expect(r.decision).toBe('reject');
    expect(r.reason).toBe('This has an answer.');
  });
});

describe('moderateQuestion: without a verdict (admin review)', () => {
  it('a refusal goes to review, even with a duplicate', async () => {
    const r = await moderate({ kind: 'refusal', category: 'general_harms' }, fakeIndex(DUP));
    expect(r.decision).toBe('review');
    expect(r.reason).toBeNull();
    expect(r.predictedSplit).toBeNull();
    expect(r.json).toEqual({
      version: 1,
      model: MODERATION_MODEL,
      decision: 'review',
      reason: null,
      output: null,
      predictedSplit: null,
      duplicateOf: DUP.id,
      duplicateScore: DUP.score,
      reviewCause: 'refusal',
      detail: 'general_harms',
      checkedAt: T,
    });
  });

  it('a failed model call goes to review, even with a duplicate', async () => {
    const r = await moderate({ kind: 'error', error: 'http 529 overloaded_error' }, fakeIndex(DUP));
    expect(r.decision).toBe('review');
    expect(r.json).toMatchObject({
      reviewCause: 'model_error',
      detail: 'http 529 overloaded_error',
      output: null,
      duplicateOf: DUP.id,
    });
  });

  it('a model that throws goes to review (model_error)', async () => {
    const r = await moderate(() => Promise.reject(new Error('boom')));
    expect(r.decision).toBe('review');
    expect(r.json.reviewCause).toBe('model_error');
    expect(r.json.detail).toBe('boom');
  });

  it('output that did not parse goes to review (invalid_output)', async () => {
    const r = await moderate(
      { kind: 'error', error: 'output is not JSON', invalidOutput: true },
      fakeIndex(DUP),
    );
    expect(r.decision).toBe('review');
    expect(r.json.reviewCause).toBe('invalid_output');
    expect(r.json.detail).toBe('output is not JSON');
  });

  it.each([
    ['predictedSplit 0.3', { predictedSplit: 0.3 }],
    ['predictedSplit 1.2', { predictedSplit: 1.2 }],
    ['a missing field', { safe: undefined }],
    ['a wrong type', { twoSided: 'yes' }],
  ])('a verdict with %s goes to review (invalid_output)', async (_name, patch) => {
    const output = { ...PASS_OUTPUT, ...patch } as unknown as ModelOutput;
    const r = await moderate({ kind: 'verdict', output, stopReason: 'end_turn' }, fakeIndex(DUP));
    expect(r.decision).toBe('review');
    expect(r.predictedSplit).toBeNull();
    expect(r.json).toMatchObject({ reviewCause: 'invalid_output', output: null });
  });

  it('accepts the bounds of predictedSplit, 0.5 and 1', async () => {
    expect((await moderate(verdictOf({ predictedSplit: 0.5 }))).decision).toBe('pass');
    expect((await moderate(verdictOf({ predictedSplit: 1 }))).decision).toBe('pass');
  });
});

describe('moderateQuestion: the calls', () => {
  it('asks the model about the question and looks for duplicates of its text in the last 365 days', async () => {
    const model = fakeModel(verdictOf());
    const index = fakeIndex(null);
    const env = withModerationDeps(moderationEnv(), { model, duplicates: index });
    await moderateQuestion(env, QUESTION, T);
    expect(model.classify).toHaveBeenCalledWith(QUESTION);
    expect(index.findDuplicate).toHaveBeenCalledWith(
      duplicateText(QUESTION.prompt, QUESTION.options),
      { since: T - DUPLICATE_WINDOW_MS, minScore: 0.9 },
    );
    expect(DUPLICATE_WINDOW_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it('runs the model call and the duplicate lookup concurrently', async () => {
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => (lookupStarted = resolve));
    const index = fakeIndex(null);
    index.findDuplicate.mockImplementation(() => {
      lookupStarted();
      return Promise.resolve(null);
    });
    // The model answers only once the lookup has started: run in sequence, this would never finish.
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000));
    const r = await Promise.race([moderate(() => started.then(() => verdictOf()), index), timeout]);
    expect(r).not.toBe('timeout');
  });

  it('with the real deps and no ANTHROPIC_API_KEY, goes to review without calling anything', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = moderationEnv({ ANTHROPIC_API_KEY: undefined });
    const r = await moderateQuestion(env, QUESTION, T);
    expect(r.decision).toBe('review');
    expect(r.json.reviewCause).toBe('model_error');
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('moderation.model_unconfigured');
  });
});

describe('indexQuestion', () => {
  it('adds the question with its prompt and labels', async () => {
    const index = fakeIndex(null);
    const env = withModerationDeps(moderationEnv(), { duplicates: index });
    await indexQuestion(env, {
      id: 'q1',
      prompt: QUESTION.prompt,
      createdAt: T,
      options: QUESTION.options,
    });
    expect(index.add).toHaveBeenCalledWith({
      id: 'q1',
      text: duplicateText(QUESTION.prompt, QUESTION.options),
      createdAt: T,
    });
  });

  it("reads the labels from the question's D1 row when not given", async () => {
    await insertQuestions([
      { id: '01K7IDX0000000000000000001', options: [{ label: 'Tea' }, { label: 'Coffee' }] },
    ]);
    const index = fakeIndex(null);
    const env = withModerationDeps(moderationEnv(), { duplicates: index });
    await indexQuestion(env, { id: '01K7IDX0000000000000000001', prompt: 'Brew?', createdAt: T });
    expect(index.add).toHaveBeenCalledWith({
      id: '01K7IDX0000000000000000001',
      text: 'Brew?\nCoffee\nTea',
      createdAt: T,
    });
  });

  it('never throws: a failed add or a missing row is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = fakeIndex(null);
    index.add.mockRejectedValue(new Error('vectorize down'));
    const env = withModerationDeps(moderationEnv(), { duplicates: index });
    await expect(
      indexQuestion(env, { id: 'q2', prompt: 'x', createdAt: T, options: QUESTION.options }),
    ).resolves.toBeUndefined();
    await expect(
      indexQuestion(env, { id: 'missing', prompt: 'x', createdAt: T }),
    ).resolves.toBeUndefined();
    expect(index.add).toHaveBeenCalledTimes(1);
    const events = warn.mock.calls.map((c) => String(c[0]));
    expect(events.some((e) => e.includes('moderation.index_failed'))).toBe(true);
    expect(events.some((e) => e.includes('moderation.index_skipped'))).toBe(true);
  });
});
