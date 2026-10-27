// AC-8: the Stakes UI is absent for every ineligibility reason. `not_verified` is the one reason
// that still shows the mode, with "Verify with Coinbase" (spec "Client app" › Today).
import { INELIGIBLE_REASONS, type IneligibleReason, type MeResponse } from '@flocked/shared';
import { describe, expect, it } from 'vitest';
import { ME } from '../../test/fixtures';
import { showsStakes, stakesOffer } from './eligibility';

const me = (eligible: boolean, reasons: IneligibleReason[] = []): MeResponse => ({
  ...ME,
  stakes: { eligible, reasons },
});

describe('stakesOffer', () => {
  it('offers Stakes to an eligible player', () => {
    expect(stakesOffer(me(true), true)).toEqual({ kind: 'play' });
    expect(showsStakes(stakesOffer(me(true), true))).toBe(true);
  });

  it('hides Stakes on a round that has no Stakes mode', () => {
    expect(stakesOffer(me(true), false)).toEqual({ kind: 'hidden', reasons: [] });
  });

  it('hides Stakes while the session is loading or signed out', () => {
    expect(showsStakes(stakesOffer(null, true))).toBe(false);
  });

  it('shows Stakes with the verify flow when only verification is missing', () => {
    expect(stakesOffer(me(false, ['not_verified']), true)).toEqual({
      kind: 'verify',
      reasons: ['not_verified'],
    });
  });

  // What `/me` answers for a new account on the stack (W10-D.2): the sheet stores the age and the
  // terms before Coinbase, so neither hides the way in.
  it('shows the verify flow to a new account, which has not attested its age or the terms yet', () => {
    const reasons: IneligibleReason[] = ['not_verified', 'age_unattested', 'tos_not_accepted'];
    expect(stakesOffer(me(false, reasons), true)).toEqual({ kind: 'verify', reasons });
    expect(stakesOffer(me(false, ['not_verified', 'tos_not_accepted']), true).kind).toBe('verify');
    expect(stakesOffer(me(false, ['not_verified', 'age_unattested']), true).kind).toBe('verify');
  });

  // AC-8, reason by reason.
  const HIDDEN = INELIGIBLE_REASONS.filter((r) => r !== 'not_verified');
  it.each(HIDDEN)('hides Stakes for %s', (reason) => {
    const offer = stakesOffer(me(false, [reason]), true);
    expect(offer.kind).toBe('hidden');
    expect(showsStakes(offer)).toBe(false);
  });

  const SHEET = ['age_unattested', 'tos_not_accepted'] as const;
  const HIDING = HIDDEN.filter((r) => !(SHEET as readonly IneligibleReason[]).includes(r));
  it('hides Stakes when another reason sits beside not_verified', () => {
    for (const reason of HIDING) {
      expect(stakesOffer(me(false, ['not_verified', reason]), true).kind).toBe('hidden');
      // The sheet's own reasons don't lift a reason that hides Stakes.
      expect(stakesOffer(me(false, ['not_verified', ...SHEET, reason]), true).kind).toBe('hidden');
    }
  });

  it('hides Stakes when the server says ineligible without saying why', () => {
    expect(stakesOffer(me(false, []), true).kind).toBe('hidden');
  });
});
