import type { WsServerMessage, WsStateMessage } from '@flocked/shared';
import { describe, expect, it } from 'vitest';
import { applyMessage, applyRoundView, modePhase, type LiveRound } from './live';
import { testRound } from '../crypto/testing';

const ID = '01JA0000000000000000000RND';
const CLOSES = 1_800_000_000;

function state(over: Partial<WsStateMessage> = {}): WsStateMessage {
  return {
    type: 'state',
    roundId: ID,
    status: 'open',
    opensAt: CLOSES - 86_400,
    closesAt: CLOSES,
    beaconRound: 100,
    beaconTime: CLOSES + 120,
    serverTime: (CLOSES - 60) * 1000,
    modes: {
      free: {
        status: 'pending',
        entrantCount: 10,
        pool: '250',
        revealedAt: null,
        claimsOpenAt: null,
        refundReason: null,
        result: null,
      },
    },
    ...over,
  };
}

const TALLY = [
  { headcount: 62, total: '1550' },
  { headcount: 38, total: '950' },
] as const;
const revealed: WsServerMessage = {
  type: 'revealed',
  roundId: ID,
  mode: 'free',
  winningOption: 1,
  tally: [...TALLY],
};
const counts = (n: number): WsServerMessage => ({
  type: 'counts',
  roundId: ID,
  modes: { free: { entrantCount: n, pool: String(n * 25) } },
});

function fold(msgs: WsServerMessage[], start: LiveRound | null = null): LiveRound | null {
  return msgs.reduce<LiveRound | null>((r, m) => applyMessage(r, m, (CLOSES - 60) * 1000), start);
}

describe('applyMessage', () => {
  it('ignores events before the first state, and events for another round', () => {
    expect(applyMessage(null, counts(5))).toBeNull();
    const r = fold([state()]);
    expect(applyMessage(r, { ...counts(99), roundId: '01JA0000000000000000000XYZ' })).toBe(r);
  });

  it('takes the server clock skew from state', () => {
    const r = applyMessage(null, state({ serverTime: 5_000 }), 2_000);
    expect(r?.skewMs).toBe(3_000);
  });

  it('applies a duplicated event once, whatever the order (idempotent)', () => {
    const once = fold([
      state(),
      counts(20),
      { type: 'revealing', roundId: ID, mode: 'free' },
      revealed,
    ]);
    const twice = fold([
      state(),
      counts(20),
      counts(20),
      { type: 'revealing', roundId: ID, mode: 'free' },
      revealed,
      revealed,
      { type: 'revealing', roundId: ID, mode: 'free' },
      counts(20),
    ]);
    expect(twice).toEqual(once);
  });

  it('never moves backwards: late counts, a stale state snapshot after the reveal', () => {
    const r = fold([state(), counts(30), counts(12), revealed, state()]);
    expect(r?.modes.free?.entrantCount).toBe(30);
    expect(r?.modes.free?.pool).toBe(750n);
    expect(r?.modes.free?.status).toBe('settled');
    expect(r?.modes.free?.result?.winningOption).toBe(1);
  });

  it('closes the round and keeps the beacon it names', () => {
    const r = fold([
      state(),
      { type: 'closed', roundId: ID, closesAt: CLOSES, beaconRound: 101, beaconTime: CLOSES + 123 },
      state(),
    ]);
    expect(r?.status).toBe('closed');
  });

  it('marks a Stakes refund proposal provisional, then final; a veto replaces a revealed result', () => {
    const stakes = state({
      modes: {
        stakes: {
          status: 'pending',
          entrantCount: 3,
          pool: '15000000',
          revealedAt: null,
          claimsOpenAt: null,
          refundReason: null,
          result: null,
        },
      },
    });
    const proposed = fold([
      stakes,
      {
        type: 'refunded',
        roundId: ID,
        mode: 'stakes',
        refundReason: 1,
        provisional: true,
        finalAt: 9,
      },
    ]);
    expect(proposed?.modes.stakes).toMatchObject({
      status: 'refund_proposed',
      provisional: true,
      finalAt: 9,
    });
    const vetoed = fold(
      [
        { ...revealed, mode: 'stakes', claimsOpenAt: 5 },
        {
          type: 'refunded',
          roundId: ID,
          mode: 'stakes',
          refundReason: 5,
          provisional: false,
          finalAt: 10,
        },
      ],
      fold([stakes]),
    );
    expect(vetoed?.modes.stakes).toMatchObject({
      status: 'refunded',
      provisional: false,
      refundReason: 5,
    });
    expect(vetoed && modePhase(vetoed, 'stakes', 0)).toBe('refunded');
  });
});

describe('applyRoundView (the polling fallback)', () => {
  it('merges GET /rounds/:id like a snapshot', () => {
    const view = testRound();
    const r = applyRoundView(null, view);
    expect(r.roundId).toBe(view.id);
    expect(r.modes.free?.entrantCount).toBe(0);
    const later = applyRoundView(r, {
      ...view,
      modes: { free: { ...view.modes.free!, entrantCount: 4, pool: '100', status: 'revealing' } },
    });
    expect(later.modes.free).toMatchObject({ entrantCount: 4, pool: 100n, status: 'revealing' });
    // An older answer doesn't undo it.
    expect(applyRoundView(later, view).modes.free?.entrantCount).toBe(4);
  });
});

describe('modePhase', () => {
  it('runs open → unsealing → counting → revealed by the clock and the events', () => {
    const r = fold([state()]);
    if (!r) throw new Error('no round');
    expect(modePhase(r, 'free', (CLOSES - 1) * 1000)).toBe('open');
    expect(modePhase(r, 'free', CLOSES * 1000)).toBe('unsealing');
    expect(modePhase(r, 'free', (CLOSES + 120) * 1000)).toBe('counting');
    expect(modePhase(applyMessage(r, revealed)!, 'free', (CLOSES + 121) * 1000)).toBe('revealed');
  });

  it('treats a closed round as closed even before closesAt on this clock', () => {
    const r = fold([state({ status: 'closed' })]);
    expect(r && modePhase(r, 'free', (CLOSES - 5) * 1000)).toBe('unsealing');
  });
});
