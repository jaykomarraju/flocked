// "Counting the flock…" for at least 1.5 seconds before the bars grow (spec "Real-time and the
// reveal" › Reveal choreography; owner decision, Oct 16, 2026, W9-Z). Small rounds reveal within
// seconds of the beacon, and on the local stack within about a second of it, so without this the
// counting state flashes or is skipped altogether and the player goes from "Unsealing in 0:00"
// straight to the bars.
//
// Only a device that watched the reveal happen holds anything back: a page loaded after the mode
// settled was never counting, and shows its result at once (it still plays the bars once per round,
// `played.ts`). The clock here is the device's own, because 1.5 s is a UI duration, not a round time.
import { useEffect, useRef, useState } from 'react';
import type { ModePhase } from '../../ws/live';

/** How long "Counting the flock…" is shown before an outcome may replace it. */
export const MIN_COUNTING_MS = 1500;

// The spec holds `revealed` back, not a refund: a refunded mode has no bars to grow, and under
// rules 4, 6, 7 and 8 no split at all, so there is nothing for the counting state to introduce.
const isOutcome = (phase: ModePhase) => phase === 'revealed';

/**
 * `phase`, with the first outcome held behind "Counting the flock…" until that state has been on
 * screen for `MIN_COUNTING_MS`. A later phase change — a Stakes veto turning a result into a refund
 * — passes straight through, because counting is long over by then.
 */
export function useCountingHold(phase: ModePhase): ModePhase {
  // The first render decides: an outcome already in hand means this device never counted.
  const [watching] = useState(() => !isOutcome(phase));
  const countingSince = useRef<number | null>(null);
  const outcomeShown = useRef(false);
  const [, redraw] = useState(0);

  // Counting starts when the phase reaches it, or — when the outcome beat the clock tick that would
  // have drawn counting — at the moment the outcome arrives.
  if (watching && !outcomeShown.current && countingSince.current === null) {
    if (phase === 'counting' || isOutcome(phase)) countingSince.current = Date.now();
  }
  const until = countingSince.current === null ? null : countingSince.current + MIN_COUNTING_MS;
  const holding =
    watching && !outcomeShown.current && isOutcome(phase) && until !== null && Date.now() < until;
  if (isOutcome(phase) && !holding) outcomeShown.current = true;

  useEffect(() => {
    if (!holding || until === null) return;
    const timer = setTimeout(() => redraw((n) => n + 1), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [holding, until]);

  return holding ? 'counting' : phase;
}
