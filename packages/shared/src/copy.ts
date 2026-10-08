// Brand vocabulary (Product_Spec.md "Overview") and voice lines (Design_Language.md "Voice").
// Voice: short, dry, deadpan; never explain the joke; never use exclamation points.

/** Brand terms, used consistently in UI copy, API enums and events. */
export const BRAND = {
  /** The majority side in a settled round (more people picked it). */
  theFlock: 'The Flock',
  /** The player picked the majority side and lost their stake (less any cap rebate). */
  gotFlocked: 'Got flocked',
  /** Players on the winning (minority) side. */
  strays: 'Strays',
  /** The player's result when they win. */
  unflocked: 'Unflocked',
  /** Consecutive game days with a winning entry. */
  strayStreak: 'Stray streak',
  /** Consecutive game days with an entry. */
  playStreak: 'Play streak',
  /** The New York date on which a round closes. */
  gameDay: 'Game day',
} as const;
export type BrandTerm = keyof typeof BRAND;

/** Voice lines exactly as written in Design_Language.md. */
export const VOICE = {
  win: 'Unflocked. You and 38% of people out-thought everyone.',
  loss: 'You got flocked. 61% thought the same thing you did.',
  sealed: 'Your pick is sealed. Nobody can see it. Not even us.',
  emptyState: 'No question yet. The sheep are deliberating.',
  error: 'Something broke. The flock is looking into it.',
  refundedTie: 'A dead heat. Nobody strayed, so everyone gets their stake back.',
  offline: "You're offline. Nothing can be sealed until you're back.",
  entryClosed: "This round just closed. Your pick wasn't sent.",
  dailyCap: "You've hit today's cap. The flock will still be here tomorrow.",
} as const;
export type VoiceLine = keyof typeof VOICE;

/** Which side of the result a share describes. */
export type ShareSide = 'win' | 'loss';

/**
 * A side's share of the valid entries as whole-percent text (Decision log, Oct 7, 2026): the winning
 * share rounds down and the losing share rounds up, so a winner never reads 50%. A share strictly
 * between 0% and 1% reads "<1%", and one strictly between 99% and 100% reads ">99%".
 */
export function formatShare(count: number, total: number, side: ShareSide): string {
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(total) || total <= 0) {
    throw new RangeError('count and total must be integers with total > 0');
  }
  if (count < 0 || count > total) throw new RangeError('count must be between 0 and total');
  if (count === 0) return '0%';
  if (count === total) return '100%';
  // Integer math: count * 100 stays exact well past any real entry count.
  const scaled = count * 100;
  if (scaled < total) return '<1%';
  if (scaled > 99 * total) return '>99%';
  const floor = Math.floor(scaled / total);
  return `${side === 'win' || scaled % total === 0 ? floor : floor + 1}%`;
}

/** Win line: the player's side had `count` of `total` valid entries. */
export function winLine(count: number, total: number): string {
  return `Unflocked. You and ${formatShare(count, total, 'win')} of people out-thought everyone.`;
}

/** Loss line: the player's side had `count` of `total` valid entries. */
export function lossLine(count: number, total: number): string {
  return `You got flocked. ${formatShare(count, total, 'loss')} thought the same thing you did.`;
}
