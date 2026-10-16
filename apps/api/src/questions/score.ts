// Queue score (spec "Question pipeline" step 3): upvotes − downvotes with a time decay, half-life 3
// days. Each vote decays from when it was cast: decayed(now) = Σ value · 2^(−(now − castAt) / H).
// SQL can't raise 2 to a power, so `questions.score` stores the same sum scaled to a fixed epoch,
// Σ value · 2^((castAt − SCORE_EPOCH_MS) / H) (each vote's `weight`, fixed when it is cast). The
// decayed score is the stored one times 2^(−(now − SCORE_EPOCH_MS) / H), a factor shared by every
// question, so `ORDER BY score DESC` is the decayed order. Weights reach 2^1023 (the double limit)
// about 8.4 years after the epoch; rebase it (one UPDATE of both tables) well before then.

/** Half-life of a vote. */
export const SCORE_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
/** The fixed epoch weights are scaled to: 2026-10-01T00:00:00Z. */
export const SCORE_EPOCH_MS = Date.UTC(2026, 9, 1);

/** A vote's weight: 2^((castAt − SCORE_EPOCH_MS) / H). */
export function voteWeight(castAt: number): number {
  return 2 ** ((castAt - SCORE_EPOCH_MS) / SCORE_HALF_LIFE_MS);
}

/** The decayed score at `t` of a stored (epoch-scaled) score. */
export function decayedScore(stored: number, t: number): number {
  return stored * 2 ** (-(t - SCORE_EPOCH_MS) / SCORE_HALF_LIFE_MS);
}

/** The score as served (`Question.score` is an integer): the decayed score, rounded. */
export function servedScore(stored: number, t: number): number {
  const s = Math.round(decayedScore(stored, t));
  return Object.is(s, -0) ? 0 : s;
}
