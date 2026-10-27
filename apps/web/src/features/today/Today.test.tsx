import {
  RoundMeResponseSchema,
  VOICE,
  type RoundMeResponse,
  type WsServerMessage,
} from '@flocked/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import entriesFixtures from '../../../../../packages/shared/test/fixtures/api/entries.json';
import { ApiError } from '../../api/client';
import { EntryRefused, submitFreeEntry } from '../../crypto/entry';
import { writePick, type StoredPick } from '../../crypto/picks';
import { apiFetch, renderApp, SIGNED_IN, TODAY } from '../../layout/testing';
import { ONBOARDED_KEY } from '../../onboarding/OnboardingModal';
import { json, ME } from '../../test/fixtures';
import { MIN_COUNTING_MS } from '../reveal/countingHold';
import { COUNTING_TITLE, UNSEALING_NOTE } from '../reveal/copy';
import { revealPlayed } from '../reveal/played';
import { PICK_LOST_LINE } from '../sealed/SealedView';
import { formatGameDay } from './api';
import { RECEIPT_MISMATCH } from './copy';
import { RECONNECTING } from './Today';

vi.mock('../../auth/SignInDialog', () => ({
  SignInDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Sign in" /> : null,
}));
vi.mock('../../crypto/entry', async (orig) => ({
  ...(await orig<object>()),
  submitFreeEntry: vi.fn(),
}));
// The trusted chain: never reached, because submitFreeEntry is mocked.
vi.mock('../../crypto/chain', async (orig) => ({
  ...(await orig<object>()),
  clientChain: () => ({
    chainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    anchor: '0x00000000000000000000000000000000000a1c40',
    drand: {
      chainHash: '',
      publicKey: '',
      scheme: 'bls-unchained-g1-rfc9380',
      genesis: 0,
      period: 3,
    },
  }),
}));

const round = TODAY.round!;
const PREV = TODAY.previousRoundId!;
const submit = vi.mocked(submitFreeEntry);

/** A WebSocket stand-in: every socket the app opens, driven by the test. */
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

function socketFor(roundId: string): FakeSocket {
  const s = FakeSocket.all.filter((x) => x.url.includes(roundId)).at(-1);
  if (!s) throw new Error(`no socket for ${roundId}`);
  return s;
}

function push(roundId: string, msg: WsServerMessage | Record<string, unknown>) {
  const s = socketFor(roundId);
  act(() => {
    if (s.readyState !== 1) {
      s.readyState = 1;
      s.onopen?.();
    }
    s.onmessage?.({ data: JSON.stringify(msg) });
  });
}

function stateMsg(over: { status?: 'open' | 'closed'; free?: Record<string, unknown> } = {}) {
  return {
    type: 'state',
    roundId: round.id,
    status: over.status ?? 'open',
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    beaconRound: round.beaconRound,
    beaconTime: round.beaconTime,
    serverTime: Date.now(),
    modes: {
      free: {
        status: 'pending',
        entrantCount: 153,
        pool: '8150',
        revealedAt: null,
        claimsOpenAt: null,
        refundReason: null,
        result: null,
        ...over.free,
      },
    },
  };
}

const TALLY = [
  { headcount: 95, total: '2375' },
  { headcount: 58, total: '1450' },
];
const revealed = {
  type: 'revealed',
  roundId: round.id,
  mode: 'free',
  winningOption: 1,
  tally: TALLY,
};

const BASE_ME: RoundMeResponse = RoundMeResponseSchema.parse(
  entriesFixtures.valid.RoundMeResponseSchema[0],
);
const BASE_FREE = BASE_ME.modes.free!;

/** `GET /rounds/:id/me` for a Free entry of 25 on `round`, before (or after) the reveal. */
function meEntry(over: { optionIndex?: 0 | 1; result?: 'win' | 'loss'; paid?: string } = {}) {
  return {
    ...BASE_ME,
    roundId: round.id,
    modes: {
      free: {
        ...BASE_FREE,
        modeStatus: over.result ? 'settled' : 'pending',
        entry: {
          ...BASE_FREE.entry,
          stake: '25',
          optionIndex: over.optionIndex ?? null,
          valid: null,
        },
        result: over.result ?? null,
        payouts: over.paid
          ? [
              {
                kind: 'win',
                amount: over.paid,
                wallet: null,
                proof: null,
                claimedAt: null,
                claimTx: null,
              },
            ]
          : [],
      },
    },
    cards: [],
  };
}
const NOT_ENTERED = { roundId: round.id, modes: {}, cards: [] };

function storedPick(over: Partial<StoredPick> = {}): StoredPick {
  return {
    v: 1,
    userId: ME.user.id,
    roundId: round.id,
    mode: 'free',
    optionIndex: 1,
    nonce: `0x${'07'.repeat(16)}`,
    stake: '25',
    entryId: BASE_FREE.entry.id,
    ciphertext: 'AAAA',
    receipt: { ...BASE_FREE.receipt!, stake: '25' },
    mismatches: [],
    savedAt: 1,
    ...over,
  };
}

const withRound = { 'GET /rounds/today': () => json(200, TODAY) };
function signedIn(
  me: unknown = NOT_ENTERED,
  prevMe: unknown = { roundId: PREV, modes: {}, cards: [] },
) {
  return {
    ...SIGNED_IN,
    ...withRound,
    [`GET /rounds/${round.id}/me`]: () => json(200, me),
    [`GET /rounds/${PREV}/me`]: () => json(200, prevMe),
  };
}

function reduceMotion(reduce: boolean) {
  const original = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((q: string) =>
    q.includes('prefers-reduced-motion') ? { ...original(q), matches: reduce } : original(q),
  );
}

const revealEl = () => document.querySelector('[data-phase="revealed"]');

/** Whether the app has fetched a URL ending in `path`. */
const fetched = (fetch: ReturnType<typeof apiFetch>, path: string) =>
  fetch.mock.calls.some(([u]) => (u instanceof Request ? u.url : u.toString()).endsWith(path));

beforeEach(() => {
  localStorage.setItem(ONBOARDED_KEY, '1');
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  // An hour before close, on a real ticking clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime((round.closesAt - 3600) * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  submit.mockReset();
  localStorage.clear();
});

describe('formatGameDay', () => {
  it('reads a game day as the date line', () => {
    expect(formatGameDay('2026-10-08')).toBe('Thursday, Oct 8');
    expect(formatGameDay('2027-01-01')).toBe('Friday, Jan 1');
  });
});

describe('Today, open', () => {
  it('shows the skeleton while the round loads', async () => {
    renderApp({ fetch: apiFetch({ 'GET /rounds/today': () => new Promise<Response>(() => {}) }) });
    expect(await screen.findByText('Loading')).toBeInTheDocument();
  });

  it('shows the error box, and Retry asks again', async () => {
    let calls = 0;
    const fetch = apiFetch({
      'GET /rounds/today': () =>
        ++calls === 1
          ? json(500, { error: { code: 'internal', message: 'Internal error' } })
          : json(200, TODAY),
    });
    renderApp({ fetch });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(VOICE.error);
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: round.question.prompt })).toBeVisible();
    expect(calls).toBe(2);
  });

  it('shows the empty state when there is no round', async () => {
    renderApp();
    expect(await screen.findByText(VOICE.emptyState)).toBeVisible();
  });

  it('signed out: the round, the crowd hint, the counter, and "Sign in to play"', async () => {
    renderApp({ fetch: apiFetch(withRound) });
    await screen.findByRole('heading', { level: 1, name: 'Pineapple on pizza?' });
    const options = screen.getByRole('radiogroup', { name: 'Pineapple on pizza?' });
    expect(
      within(options)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['🍍 Pineapple', 'No pineapple']);
    // The Free hint: a 41.25% winning share over 12 food rounds.
    expect(screen.getByText('Food days split 59/41 on average.')).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Closes in' })).toHaveTextContent('01:00:00');
    expect(screen.getByText('153 in · 8,150 points')).toBeVisible();
    expect(screen.queryByRole('radiogroup', { name: 'Stake presets' })).toBeNull();
    expect(screen.getByText('Free to play. Points have no cash value.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to play' }));
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeVisible();
  });

  it('hides Stakes for now: the static "Free" label, no toggle', async () => {
    renderApp({ fetch: apiFetch(withRound) });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('radio', { name: 'Stakes' })).toBeNull();
    expect(screen.getByText('Free')).toBeVisible();
  });

  it('follows the live counts over the round socket, idempotently', async () => {
    renderApp({ fetch: apiFetch(withRound) });
    await screen.findByText('153 in · 8,150 points');
    push(round.id, stateMsg());
    const counts = (n: number) => ({
      type: 'counts',
      roundId: round.id,
      modes: { free: { entrantCount: n, pool: String(n * 50) } },
    });
    push(round.id, counts(170));
    push(round.id, counts(160)); // a late duplicate of an older fan-out
    push(round.id, counts(170));
    expect(screen.getByText('170 in · 8,500 points')).toBeVisible();
  });

  it('keeps the last state with "Reconnecting" and polls GET /rounds/:id while the socket is down', async () => {
    let polls = 0;
    const free = { ...round.modes.free!, entrantCount: 170, pool: '9000' };
    const fetch = apiFetch({
      ...withRound,
      [`GET /rounds/${round.id}`]: () => {
        polls += 1;
        return json(200, { round: { ...round, modes: { ...round.modes, free } } });
      },
    });
    renderApp({ fetch });
    await screen.findByText('153 in · 8,150 points');
    push(round.id, stateMsg());
    act(() => socketFor(round.id).onclose?.());
    expect(await screen.findByText(RECONNECTING)).toBeVisible();
    expect(await screen.findByText('170 in · 9,000 points')).toBeVisible();
    expect(polls).toBeGreaterThan(0);
  });
});

describe('the Free entry flow', () => {
  it('presets, then "Seal my pick" → Sealed with the pick, the stake and the reveal countdown', async () => {
    submit.mockResolvedValue({ pick: storedPick(), usedTurnstile: true });
    renderApp({ fetch: apiFetch(signedIn()) });
    const seal = await screen.findByRole('button', { name: 'Seal my pick' });
    expect(seal).toBeDisabled();
    const presets = screen.getByRole('radiogroup', { name: 'Stake presets' });
    expect(within(presets).getByRole('radio', { name: '25' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(screen.getByRole('radio', { name: 'No pineapple' }));
    await userEvent.click(seal);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ optionIndex: 1, stake: 25n, userId: ME.user.id }),
      expect.anything(),
    );
    expect(await screen.findByText(VOICE.sealed)).toBeVisible();
    expect(screen.getAllByText('Sealed')[0]).toBeVisible();
    expect(screen.getByText('No pineapple')).toBeVisible();
    expect(screen.getByText('25 points')).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Reveal in' })).toHaveTextContent('01:02:00');
    expect(screen.getByRole('button', { name: 'Remind me' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Invite friends' })).toBeVisible();
  });

  it('a refused entry shows why and keeps the selection; nothing is posted', async () => {
    submit.mockRejectedValue(new EntryRefused({ kind: 'lock_leaf', field: 'questionHash' }));
    const fetch = apiFetch(signedIn());
    renderApp({ fetch });
    await userEvent.click(await screen.findByRole('radio', { name: 'No pineapple' }));
    await userEvent.click(screen.getByRole('button', { name: 'Seal my pick' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This round doesn't match its onchain record",
    );
    expect(screen.getByRole('radio', { name: 'No pineapple' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('a 4xx keeps the selection and says what happened', async () => {
    submit.mockRejectedValue(new ApiError(409, 'round_closed', 'closed'));
    renderApp({ fetch: apiFetch(signedIn()) });
    await userEvent.click(await screen.findByRole('radio', { name: 'No pineapple' }));
    await userEvent.click(screen.getByRole('button', { name: 'Seal my pick' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(VOICE.entryClosed);
    expect(screen.getByRole('radio', { name: 'No pineapple' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('a receipt that fails its checks is kept and shown on Sealed', async () => {
    submit.mockResolvedValue({
      pick: storedPick({ mismatches: ['receipt.commitment'], evidence: { swapped: true } }),
      usedTurnstile: false,
    });
    renderApp({ fetch: apiFetch(signedIn()) });
    await userEvent.click(await screen.findByRole('radio', { name: 'No pineapple' }));
    await userEvent.click(screen.getByRole('button', { name: 'Seal my pick' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(RECEIPT_MISMATCH);
    expect(screen.getByText(VOICE.sealed)).toBeVisible();
  });

  it('opens on Sealed with the pick this device stored', async () => {
    writePick(storedPick());
    renderApp({ fetch: apiFetch(signedIn(meEntry())) });
    expect(await screen.findByText(VOICE.sealed)).toBeVisible();
    expect(screen.getByText('No pineapple')).toBeVisible();
  });

  it('says "Pick not on this device" when the server has an entry this device lost', async () => {
    renderApp({ fetch: apiFetch(signedIn(meEntry())) });
    expect(await screen.findByText('Pick not on this device')).toBeVisible();
    expect(screen.getByText(PICK_LOST_LINE)).toBeVisible();
    expect(screen.getByText('25 points')).toBeVisible();
  });

  it('draws the round once when GET /me answers after GET /rounds/today, so a pick is never dropped', async () => {
    let answerMe = () => {};
    const meAnswered = new Promise<void>((r) => (answerMe = r));
    const fetch = apiFetch({
      ...signedIn(),
      'GET /me': () => meAnswered.then(() => json(200, ME)),
    });
    renderApp({ fetch });
    await waitFor(() => expect(fetched(fetch, '/rounds/today')).toBe(true));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    answerMe();
    await userEvent.click(await screen.findByRole('radio', { name: 'No pineapple' }));
    expect(screen.getByRole('button', { name: 'Seal my pick' })).toBeEnabled();
    // A remount would have opened a second socket and dropped the pick (W9-Z, CI's `ui` job).
    expect(FakeSocket.all.filter((s) => s.url.includes(round.id))).toHaveLength(1);
  });
});

/** Moves the clock past the minimum the counting state is held for (`MIN_COUNTING_MS`). */
function pastCounting() {
  vi.setSystemTime(Date.now() + MIN_COUNTING_MS);
}

describe('the reveal', () => {
  it('runs Sealed → unsealing (m:ss) → counting → the result; reduced motion fades to the end state', async () => {
    reduceMotion(true);
    writePick(storedPick());
    renderApp({ fetch: apiFetch(signedIn(meEntry())) });
    await screen.findByText(VOICE.sealed);
    push(round.id, stateMsg());
    vi.setSystemTime((round.closesAt + 18) * 1000);
    push(round.id, {
      type: 'closed',
      roundId: round.id,
      closesAt: round.closesAt,
      beaconRound: round.beaconRound,
      beaconTime: round.beaconTime,
    });
    const timer = await screen.findByRole('timer', { name: 'Unsealing in' });
    await waitFor(() => expect(timer).toHaveTextContent('1:42'), { timeout: 2500 });
    expect(screen.getByText(UNSEALING_NOTE)).toBeVisible();
    expect(screen.getByText('Your pick')).toBeVisible();
    vi.setSystemTime((round.beaconTime + 1) * 1000);
    expect(await screen.findByText(COUNTING_TITLE, {}, { timeout: 2500 })).toBeVisible();
    push(round.id, revealed);
    // Counting is held for its minimum before the bars grow.
    vi.setSystemTime((round.beaconTime + 1) * 1000 + MIN_COUNTING_MS);
    await screen.findByText(/Unflocked\. You and 37% of people/, {}, { timeout: 2500 });
    // Reduced motion: the end state at once, faded in; no 3 s growth.
    expect(revealEl()).toHaveAttribute('data-reveal-stage', 'done');
    expect(revealEl()).toHaveAttribute('data-motion', 'fade');
    expect(screen.getByText('37%')).toBeVisible();
    expect(screen.getByText('63%')).toBeVisible();
    expect(await screen.findByText(/Unflocked\. You and 37% of people/)).toBeVisible();
    expect(revealPlayed(round.id, 'free')).toBe(true);
  });

  // Spec "Real-time and the reveal" › Reveal choreography (owner decision, Oct 16, 2026).
  describe('"Counting the flock…" lasts at least 1.5 s', () => {
    /** Sealed, closed, and one second past the beacon: the counting state. */
    async function counting() {
      reduceMotion(true);
      writePick(storedPick());
      renderApp({ fetch: apiFetch(signedIn(meEntry())) });
      await screen.findByText(VOICE.sealed);
      push(round.id, stateMsg());
      vi.setSystemTime((round.beaconTime + 1) * 1000);
      push(round.id, {
        type: 'closed',
        roundId: round.id,
        closesAt: round.closesAt,
        beaconRound: round.beaconRound,
        beaconTime: round.beaconTime,
      });
      return await screen.findByText(COUNTING_TITLE, {}, { timeout: 2500 });
    }

    it('holds a result that arrives at once', async () => {
      await counting();
      push(round.id, revealed);
      // Still counting: the bars have not grown and no result card is on screen.
      expect(screen.getByText(COUNTING_TITLE)).toBeVisible();
      expect(screen.queryByText(/Unflocked\. You and 37% of people/)).toBeNull();
      vi.setSystemTime((round.beaconTime + 1) * 1000 + MIN_COUNTING_MS);
      expect(
        await screen.findByText(/Unflocked\. You and 37% of people/, {}, { timeout: 2500 }),
      ).toBeVisible();
      expect(screen.queryByText(COUNTING_TITLE)).toBeNull();
    });

    it('shows a result that arrives later as soon as it does', async () => {
      await counting();
      // Counting has already outlasted its minimum when the result lands.
      vi.setSystemTime((round.beaconTime + 1) * 1000 + MIN_COUNTING_MS + 4000);
      await waitFor(() => expect(screen.getByText(COUNTING_TITLE)).toBeVisible());
      push(round.id, revealed);
      expect(screen.queryByText(COUNTING_TITLE)).toBeNull();
      expect(screen.getByText(/Unflocked\. You and 37% of people/)).toBeVisible();
    });
  });

  it('keeps the same screen and socket when the closed round becomes previousRoundId', async () => {
    writePick(storedPick());
    let today: unknown = TODAY;
    const fetch = apiFetch({
      ...signedIn(),
      'GET /rounds/today': () => json(200, today),
      [`GET /rounds/${round.id}`]: () => json(200, { round }),
    });
    renderApp({ fetch });
    await screen.findByText(VOICE.sealed);
    push(round.id, stateMsg());
    // As the API answers once the round closes: no open round, this one still revealing.
    today = { round: null, previousRoundId: round.id, crowdHint: null };
    vi.setSystemTime((round.closesAt + 18) * 1000);
    push(round.id, {
      type: 'closed',
      roundId: round.id,
      closesAt: round.closesAt,
      beaconRound: round.beaconRound,
      beaconTime: round.beaconTime,
    });
    await waitFor(() => expect(fetched(fetch, `/rounds/${round.id}`)).toBe(true));
    const timer = await screen.findByRole('timer', { name: 'Unsealing in' });
    await waitFor(() => expect(timer).toHaveTextContent('1:42'), { timeout: 2500 });
    expect(timer).toBeInTheDocument();
    expect(FakeSocket.all.filter((s) => s.url.includes(round.id))).toHaveLength(1);
  });

  it('animates the bars over 3 s the first time, then never again on this device', async () => {
    reduceMotion(false);
    writePick(storedPick());
    vi.setSystemTime((round.beaconTime + 30) * 1000);
    const fetch = apiFetch(signedIn(meEntry({ optionIndex: 1, result: 'win', paid: '41' })));
    const first = renderApp({ fetch });
    await screen.findByText(COUNTING_TITLE);
    push(round.id, stateMsg({ status: 'closed' }));
    push(round.id, revealed);
    pastCounting();
    // The counting hold runs on a real 1.5 s timer before the bars start.
    await waitFor(() => expect(revealEl()).toHaveAttribute('data-reveal-stage', 'grow'), {
      timeout: 4000,
    });
    expect(revealEl()).toHaveAttribute('data-motion', 'full');
    expect(screen.queryByText(/Unflocked\. You and/)).toBeNull();
    // 3 s of real time, more under load.
    await waitFor(() => expect(revealEl()).toHaveAttribute('data-reveal-stage', 'done'), {
      timeout: 9000,
    });
    expect(await screen.findByText(/Unflocked\. You and 37% of people/)).toBeVisible();
    expect(await screen.findByText('+16 points')).toBeVisible();
    first.unmount();

    renderApp({ fetch });
    await screen.findByText(COUNTING_TITLE);
    push(round.id, stateMsg({ status: 'closed' }));
    push(round.id, revealed);
    pastCounting();
    await waitFor(() => expect(revealEl()).toHaveAttribute('data-reveal-stage', 'done'), {
      timeout: 4000,
    });
    expect(revealEl()).toHaveAttribute('data-motion', 'none');
  }, 15_000);

  it('a refunded mode has no animation: the refund card with its reason line', async () => {
    reduceMotion(false);
    writePick(storedPick());
    vi.setSystemTime((round.beaconTime + 30) * 1000);
    renderApp({ fetch: apiFetch(signedIn(meEntry())) });
    await screen.findByText(COUNTING_TITLE);
    push(round.id, stateMsg({ status: 'closed', free: { status: 'refunded', refundReason: 1 } }));
    expect(
      await screen.findByText('Not enough sheep showed up. Everyone gets their stake back.'),
    ).toBeVisible();
    expect(document.querySelector('[data-phase="refunded"]')).toHaveAttribute(
      'data-motion',
      'none',
    );
  });

  it('a refunded tie keeps its split from GET /rounds/:id, with the refund card and Share', async () => {
    reduceMotion(false);
    writePick(storedPick());
    vi.setSystemTime((round.beaconTime + 30) * 1000);
    const tie = [
      { headcount: 3, total: '75' },
      { headcount: 3, total: '75' },
    ];
    const settlement = {
      proposalSeq: 0,
      outcome: 'refunded',
      formulaVersion: 1,
      winningOption: null,
      tally: tie,
      lossPool: '0',
      fee: '0',
      creatorFee: '0',
      distributable: '0',
      rebatePool: '0',
      dust: '0',
      payoutRoot: null,
      bundleHash: null,
      txHash: null,
      settledAt: null,
    };
    const free = {
      ...round.modes.free!,
      status: 'refunded',
      refundReason: 3,
      revealedAt: (round.beaconTime + 20) * 1000,
      settlement,
    };
    renderApp({
      fetch: apiFetch({
        ...signedIn(meEntry()),
        [`GET /rounds/${round.id}`]: () =>
          json(200, { round: { ...round, status: 'closed', modes: { free } } }),
      }),
    });
    await screen.findByText(COUNTING_TITLE);
    push(round.id, stateMsg({ status: 'closed', free: { status: 'refunded', refundReason: 3 } }));
    expect(await screen.findByText(VOICE.refundedTie)).toBeVisible();
    expect(await screen.findAllByText('50%')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Share' })).toBeVisible();
  });

  it('reveals the previous round first; "The next question is already live" opens Today', async () => {
    reduceMotion(true);
    writePick(storedPick({ roundId: PREV }));
    vi.setSystemTime((round.closesAt - 3600) * 1000);
    const prevRound = {
      ...round,
      id: PREV,
      status: 'closed',
      closesAt: round.closesAt - 86_400,
      beaconTime: round.beaconTime - 86_400,
      beaconRound: round.beaconRound - 28_800,
    };
    renderApp({
      fetch: apiFetch({
        ...signedIn(NOT_ENTERED, {
          ...meEntry({ optionIndex: 1, result: 'win', paid: '41' }),
          roundId: PREV,
        }),
        [`GET /rounds/${PREV}`]: () => json(200, { round: prevRound }),
      }),
    });
    await screen.findByText(COUNTING_TITLE);
    push(PREV, {
      ...stateMsg({ status: 'closed' }),
      roundId: PREV,
      closesAt: prevRound.closesAt,
      beaconTime: prevRound.beaconTime,
      beaconRound: prevRound.beaconRound,
    });
    push(PREV, { ...revealed, roundId: PREV });
    expect(
      await screen.findByRole('heading', { name: 'The next question is already live' }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Pineapple on pizza\?/ }));
    expect(await screen.findByText(/Last round/)).toBeVisible();
    expect(screen.getByText(/Unflocked, \+16 points/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'See the reveal' }));
    expect(
      await screen.findByRole('heading', { name: 'The next question is already live' }),
    ).toBeVisible();
  });
});
