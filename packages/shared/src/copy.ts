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
} as const;
export type VoiceLine = keyof typeof VOICE;

/** Win line for a given share of players (whole percent) on the player's side. */
export function winLine(percent: number): string {
  return `Unflocked. You and ${percent}% of people out-thought everyone.`;
}

/** Loss line for a given share of players (whole percent) on the player's side. */
export function lossLine(percent: number): string {
  return `You got flocked. ${percent}% thought the same thing you did.`;
}
