// Split quality (spec "Question pipeline" step 5): 1 − (maxShare − 0.5) / 0.5, where maxShare is the
// larger option's share of the valid headcount. 1.0 is an even split, 0 a unanimous one. It drives
// the creators board and the authored questions on a profile.

/** Split quality from the two headcounts, or null with no valid entry. */
export function splitQuality(h0: number, h1: number): number | null {
  const total = h0 + h1;
  if (total <= 0) return null;
  const q = 1 - (Math.max(h0, h1) / total - 0.5) / 0.5;
  return Math.min(1, Math.max(0, q));
}

/** The same in SQL over two INTEGER headcount expressions (their sum must be positive). */
export function splitQualitySql(h0: string, h1: string): string {
  return `(1.0 - (MAX(${h0}, ${h1}) * 1.0 / (${h0} + ${h1}) - 0.5) / 0.5)`;
}
