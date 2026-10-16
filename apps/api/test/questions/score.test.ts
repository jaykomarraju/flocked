// Decay scoring (spec "Question pipeline" step 3: upvotes − downvotes with a time decay, half-life
// 3 days): each vote's weight is fixed when it is cast, the stored score is the epoch-scaled sum,
// and the served score is that sum decayed to now and rounded.
import { describe, expect, it } from 'vitest';
import {
  SCORE_EPOCH_MS,
  SCORE_HALF_LIFE_MS,
  decayedScore,
  servedScore,
  voteWeight,
} from '../../src/questions/score.js';

const H = SCORE_HALF_LIFE_MS;
/** A time a whole number of half-lives after the epoch, so the powers of 2 are exact. */
const at = (halfLives: number) => SCORE_EPOCH_MS + halfLives * H;

describe('voteWeight', () => {
  it('is 1 at the epoch and doubles every half-life', () => {
    expect(SCORE_HALF_LIFE_MS).toBe(3 * 24 * 60 * 60 * 1000);
    expect(voteWeight(at(0))).toBe(1);
    expect(voteWeight(at(1))).toBe(2);
    expect(voteWeight(at(5))).toBe(32);
    expect(voteWeight(at(5) + H / 2)).toBeCloseTo(32 * Math.SQRT2, 9);
  });
});

describe('decayedScore', () => {
  it('a vote counts 1 when cast and halves every 3 days', () => {
    const cast = at(4);
    expect(decayedScore(voteWeight(cast), cast)).toBe(1);
    expect(decayedScore(voteWeight(cast), cast + H)).toBe(0.5);
    expect(decayedScore(voteWeight(cast), cast + 2 * H)).toBe(0.25);
    // Any cast time, not only whole half-lives.
    const t = Date.UTC(2026, 9, 13, 7, 31, 5);
    expect(decayedScore(voteWeight(t), t)).toBeCloseTo(1, 12);
    expect(decayedScore(voteWeight(t), t + 3 * 24 * 3600 * 1000)).toBeCloseTo(0.5, 12);
  });

  it('sums votes cast at different times, each decayed from its own cast time', () => {
    // Two upvotes 6 days ago, one downvote 3 days ago, one upvote now: 2·¼ − ½ + 1 = 1.
    const now = at(6);
    const stored = 2 * voteWeight(at(4)) - voteWeight(at(5)) + voteWeight(now);
    expect(decayedScore(stored, now)).toBe(1);
    // An older, bigger tally falls below a newer, smaller one.
    const older = 4 * voteWeight(at(4));
    const newer = 3 * voteWeight(at(5));
    expect(older).toBeLessThan(newer);
    expect(decayedScore(older, at(5))).toBe(2);
    expect(decayedScore(newer, at(5))).toBe(3);
  });
});

describe('servedScore', () => {
  it('rounds to an integer', () => {
    expect(servedScore(3 * voteWeight(at(4)), at(5))).toBe(2); // 1.5
    expect(servedScore(voteWeight(at(4)), at(6))).toBe(0); // 0.25
    expect(servedScore(-3 * voteWeight(at(4)), at(5))).toBe(-1); // −1.5 rounds up
    expect(servedScore(0, at(3))).toBe(0);
  });

  it('never serves −0', () => {
    // One upvote 3 days ago and one downvote now: 0.5 − 1 = −0.5, which Math.round makes −0.
    const stored = voteWeight(at(4)) - voteWeight(at(5));
    expect(Object.is(Math.round(decayedScore(stored, at(5))), -0)).toBe(true);
    const served = servedScore(stored, at(5));
    expect(Object.is(served, 0)).toBe(true);
  });
});
