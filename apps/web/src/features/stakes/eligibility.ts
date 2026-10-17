// Who sees Stakes (spec "Client app" › Today: "Stakes hidden only by region, age or self-exclusion;
// unverified users see Stakes with 'Verify with Coinbase'"). Eligibility is the server's answer on
// `/me` (`stakes.eligible` and `stakes.reasons`, W5-B) — the client never works it out itself, so a
// page that cannot reach `/me` shows no Stakes at all rather than guessing.
//
// This is AC-8: for every reason but `not_verified` the Stakes UI is absent, toggle included.
import type { IneligibleReason, MeResponse } from '@flocked/shared';

/** What Today does with the Stakes mode for this player. */
export type StakesOffer =
  /** Eligible: the toggle shows Stakes, with the round's fixed stake and the entry flow. */
  | { kind: 'play' }
  /** Verifiable: the toggle shows Stakes, with the verify callout and "Verify with Coinbase". */
  | { kind: 'verify'; reasons: IneligibleReason[] }
  /** Hidden: no toggle, the static "Free" label, as the global artboards draw it. */
  | { kind: 'hidden'; reasons: IneligibleReason[] };

/**
 * The only reason that still shows Stakes. Everything else — region, age, terms, a break, a
 * suspension, Stakes being off — hides the mode, because the player cannot act their way into it
 * from Today.
 */
const VERIFIABLE: IneligibleReason = 'not_verified';

/**
 * What to offer, from `/me` and whether the round has a Stakes mode at all. `me` is null while the
 * session is loading or signed out: both hide Stakes.
 */
export function stakesOffer(me: MeResponse | null, roundHasStakes: boolean): StakesOffer {
  if (!me || !roundHasStakes) return { kind: 'hidden', reasons: [] };
  if (me.stakes.eligible) return { kind: 'play' };
  const reasons = me.stakes.reasons;
  // `not_verified` alone is fixable here; with any other reason beside it, Stakes stays hidden.
  if (reasons.length > 0 && reasons.every((r) => r === VERIFIABLE)) {
    return { kind: 'verify', reasons: [...reasons] };
  }
  return { kind: 'hidden', reasons: [...reasons] };
}

/** Whether the mode toggle offers Stakes at all (`stakesAvailable` on the views). */
export function showsStakes(offer: StakesOffer): boolean {
  return offer.kind !== 'hidden';
}
