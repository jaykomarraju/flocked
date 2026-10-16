// The duplicate index (spec "Question pipeline" step 2: a near-duplicate from the last 365 days,
// found by embedding similarity ≥ 0.9 with Workers AI embeddings + Vectorize).
//
// What is embedded: the prompt and both option labels (`duplicateText`), labels in a fixed order so
// swapping the options changes nothing. The prompt alone would call "Which would you rather?" with
// any two options a duplicate of every other question worded that way; emojis are decoration.
//
// The Vectorize index (cosine, 768 dimensions) stores one vector per question, id = question id,
// metadata `{ createdAt }` (epoch ms; a number metadata index, so a query can filter on it). A hit
// only counts once D1 confirms it: the question still exists, is not `rejected`, was created in the
// window (a later admin rejection or a deleted row never blocks a new question), and is not a room's
// question (W8-D: those are private to the room, never indexed, and never block a public one).
//
// AI and Vectorize have no local simulator (they throw "needs to be run remotely"), so with
// ENVIRONMENT 'local' the stand-in below is used: an exact match of the normalized text among D1
// questions. Staging and production never use it.
import { z } from 'zod';
import type { DuplicateHit, DuplicateIndex, ModerationEnv } from './types.js';

/** Workers AI text embeddings: BAAI bge-base-en-v1.5, 768 dimensions. */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const EMBEDDING_DIMENSIONS = 768;
/** How many nearest neighbours a lookup reads (the best confirmed one wins). */
export const DUPLICATE_TOP_K = 5;

/** Trim, NFC, case-fold and collapse whitespace (the local stand-in compares these). */
export function normalizeText(s: string): string {
  return s.trim().normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
}

/** The text embedded for one question: the prompt, then both labels in normalized order. */
export function duplicateText(prompt: string, options: readonly { label: string }[]): string {
  const labels = options
    .map((o) => o.label.trim())
    .sort((a, b) => {
      const x = normalizeText(a);
      const y = normalizeText(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  return [prompt.trim(), ...labels].join('\n');
}

/** One embedding. Rejects when Workers AI fails or returns something else. */
async function embed(ai: Ai, text: string): Promise<number[]> {
  const out = await ai.run(EMBEDDING_MODEL, { text: [text], pooling: 'cls' });
  const vector = 'data' in out ? out.data?.[0] : undefined;
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error('embedding: unexpected Workers AI output');
  }
  return vector;
}

/** The best of `hits` that D1 confirms: exists, not rejected, created at or after `since`. */
async function confirmBest(
  db: D1Database,
  hits: DuplicateHit[],
  since: number,
): Promise<DuplicateHit | null> {
  if (hits.length === 0) return null;
  const { results } = await db
    .prepare(
      "SELECT id FROM questions WHERE id IN (SELECT value FROM json_each(?1)) AND status != 'rejected' AND created_at >= ?2 AND room_id IS NULL",
    )
    .bind(JSON.stringify(hits.map((h) => h.id)), since)
    .all<{ id: string }>();
  const live = new Set(results.map((r) => r.id));
  let best: DuplicateHit | null = null;
  for (const h of hits) {
    if (live.has(h.id) && (!best || h.score > best.score)) best = h;
  }
  return best;
}

/** The production index: Workers AI embeddings + Vectorize, confirmed in D1. */
export function vectorizeIndex(
  env: Pick<ModerationEnv, 'DB' | 'AI' | 'VECTORIZE'>,
): DuplicateIndex {
  return {
    findDuplicate: async (text, { since, minScore }) => {
      const vector = await embed(env.AI, text);
      const { matches } = await env.VECTORIZE.query(vector, {
        topK: DUPLICATE_TOP_K,
        returnMetadata: 'indexed',
        filter: { createdAt: { $gte: since } },
      });
      const hits = matches
        .filter((m) => m.score >= minScore)
        .map((m) => ({ id: m.id, score: m.score }));
      return confirmBest(env.DB, hits, since);
    },
    add: async ({ id, text, createdAt }) => {
      const values = await embed(env.AI, text);
      await env.VECTORIZE.upsert([{ id, values, metadata: { createdAt } }]);
    },
  };
}

const StoredOptionsSchema = z.array(z.object({ label: z.string() }));

/**
 * The local stand-in (ENVIRONMENT 'local' only): the oldest D1 question created at or after `since`,
 * not rejected and not a room's, whose normalized `duplicateText` equals the normalized `text`
 * (score 1). `add` is a no-op: D1 is the index.
 */
export function localDuplicateIndex(env: Pick<ModerationEnv, 'DB'>): DuplicateIndex {
  return {
    findDuplicate: async (text, { since }) => {
      const want = normalizeText(text);
      const { results } = await env.DB.prepare(
        "SELECT id, prompt, options_json FROM questions WHERE status != 'rejected' AND created_at >= ?1 AND room_id IS NULL ORDER BY created_at, id",
      )
        .bind(since)
        .all<{ id: string; prompt: string; options_json: string }>();
      for (const row of results) {
        const options = StoredOptionsSchema.safeParse(JSON.parse(row.options_json));
        if (!options.success) continue;
        if (normalizeText(duplicateText(row.prompt, options.data)) === want) {
          return { id: row.id, score: 1 };
        }
      }
      return null;
    },
    add: () => Promise.resolve(),
  };
}

/** The duplicate index for this environment: the stand-in locally, Vectorize everywhere else. */
export function duplicateIndex(env: ModerationEnv): DuplicateIndex {
  return env.ENVIRONMENT === 'local' ? localDuplicateIndex(env) : vectorizeIndex(env);
}
