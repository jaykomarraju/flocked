// Duplicate detection (src/moderation/duplicates.ts) with fake Workers AI and Vectorize bindings:
// the embedding and query (vector, top 5, createdAt ≥ t − 365 d), the 0.9 threshold through
// moderateQuestion, D1 confirmation (a rejected, missing or out-of-window hit is ignored), the
// upsert shape; and the local stand-in (normalized text in D1).
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withModerationDeps } from '../../src/moderation/deps.js';
import {
  EMBEDDING_MODEL,
  duplicateIndex,
  duplicateText,
  localDuplicateIndex,
  normalizeText,
  vectorizeIndex,
} from '../../src/moderation/duplicates.js';
import {
  DUPLICATE_WINDOW_MS,
  indexQuestion,
  moderateQuestion,
} from '../../src/moderation/index.js';
import {
  DAY_MS,
  QUESTION,
  T,
  fakeAi,
  fakeModel,
  fakeVectorize,
  insertQuestions,
  moderationEnv,
  unitVector,
  verdictOf,
} from './moderation-fakes.js';

const SINCE = T - DUPLICATE_WINDOW_MS;
const ID = {
  live: '01K7VEC0000000000000000001',
  live2: '01K7VEC0000000000000000002',
  rejected: '01K7VEC0000000000000000003',
  old: '01K7VEC0000000000000000004',
  missing: '01K7VEC0000000000000000009',
};

beforeAll(async () => {
  await insertQuestions([
    { id: ID.live, status: 'queued', createdAt: T - 10 * DAY_MS },
    { id: ID.live2, status: 'used', createdAt: T - 300 * DAY_MS },
    { id: ID.rejected, status: 'rejected', createdAt: T - DAY_MS },
    // Vectorize's metadata filter should keep this out; D1 checks the window again.
    { id: ID.old, status: 'queued', createdAt: SINCE - 1 },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function vectorEnv(matches: { id: string; score: number }[], vector = unitVector(7)) {
  const ai = fakeAi(vector);
  const vec = fakeVectorize(matches);
  return { ai, vec, index: vectorizeIndex({ DB: env.DB, AI: ai.binding, VECTORIZE: vec.binding }) };
}

describe('vectorizeIndex.findDuplicate', () => {
  it('embeds the text and queries the top 5 created in the window', async () => {
    const { ai, vec, index } = vectorEnv([]);
    const text = duplicateText(QUESTION.prompt, QUESTION.options);
    await index.findDuplicate(text, { since: SINCE, minScore: 0.9 });
    expect(ai.run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: [text], pooling: 'cls' });
    expect(vec.query).toHaveBeenCalledTimes(1);
    const [vector, opts] = vec.query.mock.calls[0]!;
    expect(vector).toEqual(unitVector(7));
    expect(opts).toMatchObject({ topK: 5, filter: { createdAt: { $gte: SINCE } } });
  });

  it('returns the best hit at or above the threshold that D1 confirms', async () => {
    const { index } = vectorEnv([
      { id: ID.live2, score: 0.91 },
      { id: ID.live, score: 0.95 },
      { id: ID.missing, score: 0.99 },
    ]);
    const hit = await index.findDuplicate('x', { since: SINCE, minScore: 0.9 });
    expect(hit).toEqual({ id: ID.live, score: 0.95 });
  });

  it.each([
    ['rejected', ID.rejected],
    ['missing from D1', ID.missing],
    ['created before the window', ID.old],
  ])('ignores a hit that is %s', async (_name, id) => {
    const { index } = vectorEnv([{ id, score: 0.99 }]);
    expect(await index.findDuplicate('x', { since: SINCE, minScore: 0.9 })).toBeNull();
    // A confirmed hit below it still counts.
    const both = vectorEnv([
      { id, score: 0.99 },
      { id: ID.live2, score: 0.92 },
    ]);
    expect(await both.index.findDuplicate('x', { since: SINCE, minScore: 0.9 })).toEqual({
      id: ID.live2,
      score: 0.92,
    });
  });

  it('rejects when Workers AI fails or returns the wrong shape', async () => {
    const failing = vectorizeIndex({
      DB: env.DB,
      AI: fakeAi(new Error('ai down')).binding,
      VECTORIZE: fakeVectorize().binding,
    });
    await expect(failing.findDuplicate('x', { since: SINCE, minScore: 0.9 })).rejects.toThrow(
      'ai down',
    );
    const short = vectorEnv([], [0.1, 0.2]);
    await expect(short.index.findDuplicate('x', { since: SINCE, minScore: 0.9 })).rejects.toThrow(
      'unexpected Workers AI output',
    );
  });
});

describe('the 0.9 threshold through moderateQuestion', () => {
  const decide = async (score: number) => {
    const { index } = vectorEnv([{ id: ID.live, score }]);
    const e = withModerationDeps(moderationEnv(), {
      model: fakeModel(verdictOf()),
      duplicates: index,
    });
    return moderateQuestion(e, QUESTION, T);
  };

  it('0.89 is not a duplicate', async () => {
    expect((await decide(0.89)).decision).toBe('pass');
  });

  it('0.9 is a duplicate', async () => {
    const r = await decide(0.9);
    expect(r.decision).toBe('reject');
    expect(r.json).toMatchObject({ duplicateOf: ID.live, duplicateScore: 0.9 });
  });

  it('a failing embedding sends a passing question to review', async () => {
    const e = withModerationDeps(moderationEnv(), {
      model: fakeModel(verdictOf()),
      duplicates: vectorizeIndex({
        DB: env.DB,
        AI: fakeAi(new Error('ai down')).binding,
        VECTORIZE: fakeVectorize().binding,
      }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await moderateQuestion(e, QUESTION, T);
    expect(r.decision).toBe('review');
    expect(r.json.reviewCause).toBe('duplicate_lookup_failed');
  });
});

describe('vectorizeIndex.add', () => {
  it('upserts the embedding with the question id and createdAt metadata', async () => {
    const { ai, vec, index } = vectorEnv([]);
    await index.add({ id: 'q1', text: 'Coffee?\nCoffee\nTea', createdAt: T });
    expect(ai.run).toHaveBeenCalledWith(EMBEDDING_MODEL, {
      text: ['Coffee?\nCoffee\nTea'],
      pooling: 'cls',
    });
    expect(vec.upsert).toHaveBeenCalledWith([
      { id: 'q1', values: unitVector(7), metadata: { createdAt: T } },
    ]);
  });

  it('indexQuestion upserts through the registered index', async () => {
    const { vec, index } = vectorEnv([]);
    const e = withModerationDeps(moderationEnv(), { duplicates: index });
    await indexQuestion(e, { id: ID.live, prompt: 'Coffee or tea first thing?', createdAt: T });
    expect(vec.upsert).toHaveBeenCalledWith([
      { id: ID.live, values: unitVector(7), metadata: { createdAt: T } },
    ]);
  });
});

describe('duplicateText', () => {
  it('is the prompt and both labels, the labels in normalized order', () => {
    expect(duplicateText(' Brew? ', [{ label: 'tea' }, { label: 'Coffee ' }])).toBe(
      'Brew?\nCoffee\ntea',
    );
    expect(duplicateText('Brew?', [{ label: 'Coffee' }, { label: 'tea' }])).toBe(
      'Brew?\nCoffee\ntea',
    );
  });

  it('normalizeText trims, NFC-normalizes, case-folds and collapses whitespace', () => {
    expect(normalizeText('  Café  OR\n\tTEA ')).toBe('café or tea');
  });
});

describe('the local stand-in', () => {
  const local = () => localDuplicateIndex({ DB: env.DB });

  it('finds a question with the same normalized prompt and labels (score 1)', async () => {
    const text = duplicateText('  COFFEE or tea   first thing? ', [
      { label: 'tea' },
      { label: 'coffee' },
    ]);
    expect(await local().findDuplicate(text, { since: SINCE, minScore: 0.9 })).toEqual({
      id: ID.live2,
      score: 1,
    });
  });

  it('ignores other wording, rejected questions and questions before the window', async () => {
    const other = duplicateText('Coffee or tea first thing?', [
      { label: 'Coffee' },
      { label: 'Water' },
    ]);
    expect(await local().findDuplicate(other, { since: SINCE, minScore: 0.9 })).toBeNull();
    // Only the rejected and the old rows remain once the window starts after the live ones.
    const text = duplicateText(QUESTION.prompt, QUESTION.options);
    expect(await local().findDuplicate(text, { since: T - 5 * DAY_MS, minScore: 0.9 })).toBeNull();
  });

  it('add is a no-op', async () => {
    await expect(local().add({ id: 'q', text: 'x', createdAt: T })).resolves.toBeUndefined();
  });

  it('is what duplicateIndex uses only when ENVIRONMENT is local', async () => {
    const text = duplicateText(QUESTION.prompt, QUESTION.options);
    const ai = fakeAi();
    const vec = fakeVectorize([]);
    const bindings = { AI: ai.binding, VECTORIZE: vec.binding };

    const localHit = await duplicateIndex(
      moderationEnv({ ENVIRONMENT: 'local', ...bindings }),
    ).findDuplicate(text, { since: SINCE, minScore: 0.9 });
    expect(localHit).toEqual({ id: ID.live2, score: 1 });
    expect(ai.run).not.toHaveBeenCalled();

    const stagingHit = await duplicateIndex(
      moderationEnv({ ENVIRONMENT: 'staging', ...bindings }),
    ).findDuplicate(text, { since: SINCE, minScore: 0.9 });
    expect(stagingHit).toBeNull();
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(vec.query).toHaveBeenCalledTimes(1);
  });
});
