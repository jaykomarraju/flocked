// Fakes for the moderation tests: a rubric model that returns a fixed verdict, a duplicate index
// with a fixed lookup result, fake Workers AI and Vectorize bindings, and D1 question rows.
import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../../src/moderation/duplicates.js';
import type {
  DuplicateHit,
  DuplicateIndex,
  ModelOutput,
  ModelVerdict,
  ModerationEnv,
  ModerationInput,
  ModerationModel,
} from '../../src/moderation/index.js';

/** 2026-10-15 12:00 UTC. */
export const T = Date.UTC(2026, 9, 15, 12, 0, 0);
export const DAY_MS = 24 * 60 * 60 * 1000;

export const QUESTION: ModerationInput = {
  prompt: 'Coffee or tea first thing?',
  options: [{ label: 'Coffee', emoji: '☕' }, { label: 'Tea' }],
  category: 'food',
};

export const PASS_OUTPUT: ModelOutput = {
  safe: true,
  twoSided: true,
  preferenceBased: true,
  predictedSplit: 0.6,
  reason: '',
};

export const verdictOf = (output: Partial<ModelOutput> = {}): ModelVerdict => ({
  kind: 'verdict',
  output: { ...PASS_OUTPUT, ...output },
  stopReason: 'end_turn',
});

export function fakeModel(verdict: ModelVerdict | (() => Promise<ModelVerdict>)) {
  const classify = vi.fn<ModerationModel['classify']>(() =>
    typeof verdict === 'function' ? verdict() : Promise.resolve(verdict),
  );
  return { classify } satisfies ModerationModel;
}

/** A duplicate index whose lookup returns `hit` (or rejects with `fail`). */
export function fakeIndex(hit: DuplicateHit | null, fail?: Error) {
  const findDuplicate = vi.fn<DuplicateIndex['findDuplicate']>(() =>
    fail ? Promise.reject(fail) : Promise.resolve(hit),
  );
  const add = vi.fn<DuplicateIndex['add']>(() => Promise.resolve());
  return { findDuplicate, add } satisfies DuplicateIndex;
}

/** A per-test copy of the test env (fakes register per env object), with overrides. */
export function moderationEnv(overrides: Partial<ModerationEnv> = {}): ModerationEnv {
  return { ...env, ...overrides };
}

/** A unit vector along axis `i` (768 dimensions), so tests can tell embeddings apart. */
export function unitVector(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[i % EMBEDDING_DIMENSIONS] = 1;
  return v;
}

/** Fake Workers AI: every text embeds to `vector` (or the call rejects). */
export function fakeAi(vector: number[] | Error = unitVector(0)) {
  const run = vi.fn((_model: string, _inputs: { text: string[]; pooling?: string }) =>
    vector instanceof Error
      ? Promise.reject(vector)
      : Promise.resolve({ shape: [1, vector.length], data: [vector], pooling: 'cls' }),
  );
  return { binding: { run } as unknown as Ai, run };
}

/** Fake Vectorize: every query returns `matches`; upserts are recorded. */
export function fakeVectorize(matches: { id: string; score: number }[] = []) {
  const query = vi.fn((_vector: number[], _opts?: VectorizeQueryOptions) =>
    Promise.resolve({ matches, count: matches.length }),
  );
  const upsert = vi.fn((_vectors: VectorizeVector[]) =>
    Promise.resolve({ mutationId: 'mutation-1' }),
  );
  return { binding: { query, upsert } as unknown as Vectorize, query, upsert };
}

export interface QuestionRow {
  id: string;
  prompt?: string;
  options?: { label: string; emoji?: string }[];
  status?: 'submitted' | 'rejected' | 'queued' | 'scheduled' | 'used';
  createdAt?: number;
}

/** Inserts house questions (no author) into this file's D1. */
export async function insertQuestions(rows: QuestionRow[]): Promise<void> {
  await env.DB.batch(
    rows.map((q) => {
      const status = q.status ?? 'queued';
      const createdAt = q.createdAt ?? T - DAY_MS;
      const options = (q.options ?? [{ label: 'Coffee' }, { label: 'Tea' }]).map((o) => ({
        label: o.label,
        emoji: o.emoji ?? '',
      }));
      return env.DB.prepare(
        'INSERT INTO questions (id, author_user_id, prompt, options_json, category, status, created_at, rejection_reason, rejected_at) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
      ).bind(
        q.id,
        q.prompt ?? 'Coffee or tea first thing?',
        JSON.stringify(options),
        'food',
        status,
        createdAt,
        status === 'rejected' ? 'Rejected' : null,
        status === 'rejected' ? createdAt : null,
      );
    }),
  );
}
