// The Stakes reveal (spec "Real-time and the reveal" › Reveal choreography): a Stakes result shows
// as soon as the proposal confirms, carrying "Provisional. Final at 11:03pm" and the payout it will
// pay once final; at final the chip goes and the payout moves to Claims; a guardian veto arrives as
// a refund and redraws the card as refunded.
//
// It drives the real Today screen through the round socket, the way the server would.
import { RoundMeResponseSchema, type RoundMeResponse, type WsServerMessage } from '@flocked/shared';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import entriesFixtures from '../../../../../packages/shared/test/fixtures/api/entries.json';
import { apiFetch, renderApp, SIGNED_IN, TODAY } from '../../layout/testing';
import { ONBOARDED_KEY } from '../../onboarding/OnboardingModal';
import { json, ME } from '../../test/fixtures';
import { MIN_COUNTING_MS } from '../reveal/countingHold';
import { writeStakesPick, type StoredStakesPick } from './picks';

vi.mock('../../auth/SignInDialog', async (orig) => ({
  ...(await orig<object>()),
  SignInDialog: () => null,
}));

const round = TODAY.round!;
const STAKE = '5000000';
const PAYOUT = '11750000';
/** The end of the challenge window: 11:03pm on the player's clock. */
const CLAIMS_OPEN_AT = new Date(2026, 9, 8, 23, 3, 0).getTime();

class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

function push(msg: WsServerMessage | Record<string, unknown>) {
  const s = FakeSocket.all.filter((x) => x.url.includes(round.id)).at(-1);
  if (!s) throw new Error('no socket');
  act(() => {
    if (s.readyState !== 1) {
      s.readyState = 1;
      s.onopen?.();
    }
    s.onmessage?.({ data: JSON.stringify(msg) });
  });
}

/** The round with a Stakes mode, closed and past the beacon. */
const stakesRound = {
  ...round,
  modes: {
    ...round.modes,
    stakes: {
      status: 'pending',
      entrantCount: 212,
      pool: '1060000000',
      chainRoundId: '7',
      revealedAt: null,
      claimsOpenAt: null,
      finalAt: null,
      refundReason: null,
      settlement: null,
    },
  },
};

function stateMsg(over: Record<string, unknown> = {}) {
  return {
    type: 'state',
    roundId: round.id,
    status: 'closed',
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    beaconRound: round.beaconRound,
    beaconTime: round.beaconTime,
    serverTime: Date.now(),
    modes: {
      stakes: {
        status: 'pending',
        entrantCount: 212,
        pool: '1060000000',
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
  { headcount: 125, total: '625000000' },
  { headcount: 87, total: '435000000' },
];

const revealed = {
  type: 'revealed',
  roundId: round.id,
  mode: 'stakes',
  winningOption: 1,
  tally: TALLY,
  claimsOpenAt: CLAIMS_OPEN_AT,
};

const BASE_ME: RoundMeResponse = RoundMeResponseSchema.parse(
  entriesFixtures.valid.RoundMeResponseSchema[0],
);

/** `GET /rounds/:id/me` for a 5 USDC Stakes entry on option 1. */
function meEntry(over: { result?: 'win' | 'refund'; paid?: string } = {}) {
  return {
    ...BASE_ME,
    roundId: round.id,
    modes: {
      stakes: {
        modeStatus: over.result ? 'settle_proposed' : 'pending',
        entry: {
          ...BASE_ME.modes.free!.entry,
          stake: STAKE,
          optionIndex: 1,
          wallet: '0x00000000000000000000000000000000000a11e7',
          txHash: `0x${'77'.repeat(32)}`,
          blockNumber: 1,
          logIndex: 0,
          valid: true,
          voidReason: null,
        },
        receipt: null,
        inclusionProof: null,
        result: over.result ?? null,
        payouts: over.paid
          ? [
              {
                kind: over.result === 'refund' ? 'refund' : 'win',
                amount: over.paid,
                wallet: '0x00000000000000000000000000000000000a11e7',
                proof: [],
                claimedAt: null,
                claimTx: null,
              },
            ]
          : [],
        claimsOpenAt: over.result ? CLAIMS_OPEN_AT : null,
      },
    },
    cards: [],
  };
}

function stakesPick(): StoredStakesPick {
  return {
    v: 1,
    userId: ME.user.id,
    roundId: round.id,
    mode: 'stakes',
    optionIndex: 1,
    nonce: `0x${'07'.repeat(16)}`,
    stake: STAKE,
    ciphertext: 'AAAA',
    wallet: '0x00000000000000000000000000000000000a11e7',
    txHashes: [`0x${'77'.repeat(32)}`],
    savedAt: Date.now(),
  };
}

function signedIn(me: unknown) {
  return {
    ...SIGNED_IN,
    'GET /rounds/today': () => json(200, { ...TODAY, round: stakesRound }),
    [`GET /rounds/${round.id}`]: () => json(200, { round: stakesRound }),
    [`GET /rounds/${round.id}/me`]: () => json(200, me),
    [`GET /rounds/${TODAY.previousRoundId!}/me`]: () =>
      json(200, { roundId: TODAY.previousRoundId, modes: {}, cards: [] }),
  };
}

beforeEach(() => {
  localStorage.setItem(ONBOARDED_KEY, '1');
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime((round.beaconTime + 1) * 1000);
  // No motion: the result card is on screen as soon as the phase reaches it.
  const original = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((q: string) =>
    q.includes('prefers-reduced-motion') ? { ...original(q), matches: true } : original(q),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Past the hold the counting state gets (`MIN_COUNTING_MS`). */
const pastCounting = () => vi.setSystemTime(Date.now() + MIN_COUNTING_MS);

describe('the Stakes reveal', () => {
  it('shows the result as provisional, with "Final at" and the payout once final', async () => {
    writeStakesPick(stakesPick());
    renderApp({ fetch: apiFetch(signedIn(meEntry({ result: 'win', paid: PAYOUT }))) });
    await screen.findByText(/Counting the flock/);
    push(stateMsg());
    push(revealed);
    pastCounting();

    expect(
      await screen.findByText(/Unflocked\. You and 41% of people/, {}, { timeout: 2500 }),
    ).toBeVisible();
    // The chip names when it becomes final, and the figure is what Claims will pay.
    expect(screen.getByText(/Provisional\. Final at \d{1,2}:\d{2}[ap]m/)).toBeVisible();
    expect(screen.getByText('Payout, once final')).toBeVisible();
    expect(screen.getByText('11.75 USDC')).toBeVisible();
    // Counted in USDC, not points (Paper draws the stake as "5 USDC").
    expect(screen.getByText('5 USDC')).toBeVisible();
  });

  it('drops the chip and names the profit once the mode is final', async () => {
    writeStakesPick(stakesPick());
    renderApp({ fetch: apiFetch(signedIn(meEntry({ result: 'win', paid: PAYOUT }))) });
    await screen.findByText(/Counting the flock/);
    push(stateMsg());
    push(revealed);
    pastCounting();
    await screen.findByText(/Unflocked\. You and 41% of people/, {}, { timeout: 2500 });

    // The settlement goes final: `settled`, no claimsOpenAt ahead of it.
    push(
      stateMsg({
        modes: {
          stakes: {
            status: 'settled',
            entrantCount: 212,
            pool: '1060000000',
            revealedAt: Date.now(),
            claimsOpenAt: CLAIMS_OPEN_AT,
            refundReason: null,
            result: { winningOption: 1, tally: TALLY },
          },
        },
      }),
    );
    await waitFor(() => expect(screen.queryByText(/Provisional\. Final at/)).toBeNull());
    expect(screen.getByText('Won')).toBeVisible();
    expect(screen.getByText('+6.75 USDC')).toBeVisible();
  });

  it('redraws the card as refunded when the guardian vetoes', async () => {
    writeStakesPick(stakesPick());
    renderApp({ fetch: apiFetch(signedIn(meEntry({ result: 'win', paid: PAYOUT }))) });
    await screen.findByText(/Counting the flock/);
    push(stateMsg());
    push(revealed);
    pastCounting();
    await screen.findByText(/Unflocked\. You and 41% of people/, {}, { timeout: 2500 });

    // The veto re-proposes as a refund; its window ends later than the settlement's.
    push({
      type: 'refunded',
      roundId: round.id,
      mode: 'stakes',
      refundReason: 5,
      provisional: true,
      finalAt: CLAIMS_OPEN_AT + 7_200_000,
    });
    expect(
      await screen.findByText(
        'The result was challenged and thrown out. Everyone gets their stake back.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Returned, once final')).toBeVisible();
    expect(screen.queryByText(/Unflocked\. You and 41% of people/)).toBeNull();

    // And the final refund that follows drops the provisional wording.
    push({
      type: 'refunded',
      roundId: round.id,
      mode: 'stakes',
      refundReason: 5,
      provisional: false,
      finalAt: CLAIMS_OPEN_AT + 7_200_001,
    });
    await waitFor(() => expect(screen.getByText('Returned')).toBeVisible());
  });

  it('never moves back to the vetoed refund when a stale duplicate arrives (R5)', async () => {
    writeStakesPick(stakesPick());
    renderApp({ fetch: apiFetch(signedIn(meEntry({ result: 'win', paid: PAYOUT }))) });
    await screen.findByText(/Counting the flock/);
    push(stateMsg());
    // A refund was proposed first, then vetoed and re-proposed as the settlement.
    push({
      type: 'refunded',
      roundId: round.id,
      mode: 'stakes',
      refundReason: 1,
      provisional: true,
      finalAt: CLAIMS_OPEN_AT - 7_200_000,
    });
    push(revealed);
    pastCounting();
    await screen.findByText(/Unflocked\. You and 41% of people/, {}, { timeout: 2500 });

    // The old proposal arrives again (a retried fan-out), and a reconnect re-sends the old state.
    push({
      type: 'refunded',
      roundId: round.id,
      mode: 'stakes',
      refundReason: 1,
      provisional: true,
      finalAt: CLAIMS_OPEN_AT - 7_200_000,
    });
    push(
      stateMsg({
        modes: {
          stakes: {
            status: 'refund_proposed',
            entrantCount: 212,
            pool: '1060000000',
            revealedAt: Date.now(),
            claimsOpenAt: CLAIMS_OPEN_AT - 7_200_000,
            refundReason: 1,
            result: null,
          },
        },
      }),
    );
    // The result stays; no refund is drawn over it.
    expect(screen.getByText(/Unflocked\. You and 41% of people/)).toBeVisible();
    expect(screen.queryByText(/Everyone gets their stake back/)).toBeNull();
  });
});
