import { flockedEscrowAbi } from '@flocked/abi';
import type { ClaimsResponse, RoundView } from '@flocked/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { decodeFunctionData, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth/session';
import { connectWallet, createWagmiConfig } from '../../auth/wallet';
import { apiFetch, setBreakpoint, SIGNED_IN, TODAY } from '../../layout/testing';
import { json } from '../../test/fixtures';
import { WalletError, sendSponsoredCalls } from '../../wallet/send';
import { CLAIMED_POLL_MS, Claims } from './Claims';
import { EMPTY_LINE, PENDING_NOTE } from './copy';

vi.mock('../../auth/wallet', async (orig) => ({
  ...(await orig<object>()),
  connectWallet: vi.fn(),
}));
vi.mock('../../wallet/send', async (orig) => ({
  ...(await orig<object>()),
  sendSponsoredCalls: vi.fn(),
}));
// The trusted chain: the escrow the claim calls go to (apps/web/src/crypto/chain.ts).
vi.mock('../../crypto/chain', async (orig) => ({
  ...(await orig<object>()),
  clientChain: () => ({
    chainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    anchor: '0x00000000000000000000000000000000000a1c40' as Address,
    escrow: '0x00000000000000000000000000000000000e5c70' as Address,
    usdc: '0x0000000000000000000000000000000000005d0c' as Address,
    drand: {
      chainHash: '',
      publicKey: '',
      scheme: 'bls-unchained-g1-rfc9380',
      genesis: 0,
      period: 3,
    },
  }),
}));
/** The wallet wagmi already has connected, as each test sets it. */
const wagmi = vi.hoisted(() => ({ account: undefined as string | undefined }));
vi.mock('wagmi/actions', async (orig) => ({
  ...(await orig<object>()),
  getAccount: () => ({ address: wagmi.account }),
}));

const send = vi.mocked(sendSponsoredCalls);
const connect = vi.mocked(connectWallet);

const WALLET = '0x3f2c00000000000000000000000000000000a91c';
const MIXED_CASE = '0x3F2C00000000000000000000000000000000A91C' as Address;

const BASE = TODAY.round!;
function round(id: string, gameDay: string, prompt: string): RoundView {
  return { ...BASE, id, gameDay, question: { ...BASE.question, prompt } };
}
const WON = round('01K6Z8Y4N2R7VQ3M5T9W1XB0CD', '2026-10-07', 'Pineapple on pizza: yes or no?');
const REFUNDED = round('01K6Z8Y4N2R7VQ3M5T9W1XB0CE', '2026-10-05', 'Is cereal a soup?');
const LATER = round(
  '01K6Z8Y4N2R7VQ3M5T9W1XB0CF',
  '2026-10-08',
  'One horse-sized duck or 100 duck-sized horses?',
);

/** 11:03pm on the viewer's own clock, far enough out that it is never already open. */
const OPENS_AT = new Date(2099, 9, 8, 23, 3).getTime();

const PROOF = ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];

const CLAIMS: ClaimsResponse = {
  claims: [
    {
      roundId: WON.id,
      chainRoundId: '17',
      kind: 'win',
      account: WALLET,
      amount: '12670000',
      proof: PROOF,
      claimsOpenAt: null,
      userId: null,
    },
    {
      roundId: REFUNDED.id,
      chainRoundId: '16',
      kind: 'refund',
      account: WALLET,
      amount: '5000000',
      proof: null,
      claimsOpenAt: 1_600_000_000_000,
      userId: null,
    },
    {
      roundId: LATER.id,
      chainRoundId: '18',
      kind: 'win',
      account: WALLET,
      amount: '11750000',
      proof: PROOF,
      claimsOpenAt: OPENS_AT,
      userId: null,
    },
  ],
};

const ROUNDS = Object.fromEntries(
  [WON, REFUNDED, LATER].map((r) => [`GET /rounds/${r.id}`, () => json(200, { round: r })]),
);

const wagmiConfig = createWagmiConfig();

function renderClaims(fetch: typeof globalThis.fetch) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/claims', element: <Claims /> },
      { path: '/', element: <p>Today</p> },
    ],
    { initialEntries: ['/claims'] },
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider wagmiConfig={wagmiConfig} fetch={fetch} origin="http://app.test">
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** The URLs the stub `fetch` was asked for. */
function urls(fetch: ReturnType<typeof apiFetch>): string[] {
  return fetch.mock.calls.map(([u]) => (u instanceof Request ? u.url : u.toString()));
}

beforeEach(() => {
  setBreakpoint('mobile');
  send.mockReset();
  connect.mockReset();
  wagmi.account = WALLET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Claims', () => {
  it('lists each payout with its round, amount and claim-open time', async () => {
    renderClaims(apiFetch({ ...SIGNED_IN, 'GET /claims': () => json(200, CLAIMS), ...ROUNDS }));

    expect(await screen.findByText('Pineapple on pizza: yes or no?')).toBeInTheDocument();
    expect(screen.getByText('Wed, Oct 7 · Won')).toBeInTheDocument();
    expect(screen.getByText('Mon, Oct 5 · Refunded')).toBeInTheDocument();
    expect(screen.getByText('Thu, Oct 8 · Won')).toBeInTheDocument();
    expect(screen.getByText('12.67 USDC')).toBeInTheDocument();
    expect(screen.getByText('11.75 USDC')).toBeInTheDocument();
    expect(screen.getAllByText('Ready')).toHaveLength(2);
    expect(screen.getByText('Opens 11:03pm')).toBeInTheDocument();
  });

  it('totals only the payouts the escrow will take, and says what is waiting', async () => {
    renderClaims(apiFetch({ ...SIGNED_IN, 'GET /claims': () => json(200, CLAIMS), ...ROUNDS }));

    expect(await screen.findByText('17.67 USDC')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 are ready. The third opens at 11:03pm.')).toBeInTheDocument();
    expect(screen.getByText(/0x3f2c…a91c/)).toBeInTheDocument();
  });

  it('"Claim all" confirms, then sends every ready payout in one batch and no waiting one', async () => {
    const user = userEvent.setup();
    send.mockResolvedValue({ id: '0x1', txHashes: [] });
    const fetch = apiFetch({ ...SIGNED_IN, 'GET /claims': () => json(200, CLAIMS), ...ROUNDS });
    renderClaims(fetch);

    await user.click(await screen.findByRole('button', { name: 'Claim all' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Two payouts, one transaction/)).toBeInTheDocument();
    expect(within(dialog).getByText('Wed, Oct 7 · Won')).toBeInTheDocument();
    expect(within(dialog).queryByText('Thu, Oct 8 · Won')).not.toBeInTheDocument();
    expect(
      within(dialog).getByText('The Oct 8 payout opens at 11:03pm. Claim it then.'),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Claim 17.67 USDC' }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sent = send.mock.calls[0]![1];
    expect(sent.chainId).toBe(31337);
    const decoded = sent.calls.map((c) =>
      decodeFunctionData({ abi: flockedEscrowAbi, data: c.data }),
    );
    expect(decoded.map((d) => d.functionName)).toEqual(['claim', 'claimRefund']);
    expect(decoded.map((d) => (d.args as readonly unknown[])[0])).toEqual([17n, 16n]);
  });

  it('claims only the connected wallet\u2019s payouts, and names the ones that need another', async () => {
    const user = userEvent.setup();
    send.mockResolvedValue({ id: '0x1', txHashes: [] });
    // A merged account's payout, ready but owned by a different wallet: the escrow builds its leaf
    // from `msg.sender`, so batching it with ours would revert.
    const other = '0x00000000000000000000000000000000000beef0';
    const claims: ClaimsResponse = {
      ...CLAIMS,
      claims: [
        ...CLAIMS.claims,
        { ...CLAIMS.claims[0]!, chainRoundId: '19', account: other, claimsOpenAt: null },
      ],
    };
    const fetch = apiFetch({ ...SIGNED_IN, 'GET /claims': () => json(200, claims), ...ROUNDS });
    renderClaims(fetch);

    expect(
      await screen.findByText(/One other payout is ready for a different wallet/),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Claim all' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Claim 17.67 USDC' }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const rounds = send.mock.calls[0]![1].calls.map(
      (c) =>
        (decodeFunctionData({ abi: flockedEscrowAbi, data: c.data }).args as readonly unknown[])[0],
    );
    expect(rounds).toEqual([17n, 16n]);
    expect(rounds).not.toContain(19n);
  });

  it('shows the pending state while the batch is out and refetches once it lands', async () => {
    const user = userEvent.setup();
    let land = () => undefined as unknown;
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = () => resolve({ id: '0x1', txHashes: [] });
        }),
    );
    const fetch = apiFetch({ ...SIGNED_IN, 'GET /claims': () => json(200, CLAIMS), ...ROUNDS });
    renderClaims(fetch);

    await user.click(await screen.findByRole('button', { name: 'Claim all' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Claim 17.67 USDC' }));

    expect(await screen.findByText(PENDING_NOTE)).toBeInTheDocument();
    expect(screen.getAllByText('Claiming')).toHaveLength(3); // two rows and the CTA
    expect(screen.getByText('Opens 11:03pm')).toBeInTheDocument();

    const before = urls(fetch).filter((u) => u.includes('/claims')).length;
    land();
    await waitFor(() =>
      expect(urls(fetch).filter((u) => u.includes('/claims')).length).toBeGreaterThan(before),
    );
  });

  // `/claims` drops a payout only once the indexer has seen its `Claimed`, which trails the block:
  // on the stack the claimed row came back as "Ready" after the one refetch (W10-D.2).
  it('hides a claimed payout while /claims still lists it, and asks again until it is gone', async () => {
    const user = userEvent.setup();
    let landed = false;
    let staleServed = 0;
    let freshServed = 0;
    send.mockImplementation(() => {
      landed = true;
      return Promise.resolve({ id: '0x1', txHashes: [] });
    });
    const fetch = apiFetch({
      ...SIGNED_IN,
      'GET /claims': () => {
        if (!landed) return json(200, CLAIMS);
        if (staleServed < 1) {
          staleServed += 1;
          return json(200, CLAIMS);
        }
        freshServed += 1;
        return json(200, { claims: [CLAIMS.claims[2]!] });
      },
      ...ROUNDS,
    });
    renderClaims(fetch);

    await user.click(await screen.findByRole('button', { name: 'Claim all' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Claim 17.67 USDC' }));

    // Gone as soon as the batch lands, though `/claims` still lists it: nothing to claim twice.
    await waitFor(() => expect(staleServed).toBe(1));
    await waitFor(() =>
      expect(screen.queryByText('Pineapple on pizza: yes or no?')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Is cereal a soup?')).not.toBeInTheDocument();
    expect(screen.getByText('One horse-sized duck or 100 duck-sized horses?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim all' })).toBeDisabled();
    // And asked again until the indexer has caught up.
    await waitFor(() => expect(freshServed).toBeGreaterThan(0), {
      timeout: CLAIMED_POLL_MS * 2,
    });
  }, 15_000);

  it('says what happened when the wallet turns the claim down', async () => {
    const user = userEvent.setup();
    send.mockRejectedValue(new WalletError('rejected'));
    renderClaims(apiFetch({ ...SIGNED_IN, 'GET /claims': () => json(200, CLAIMS), ...ROUNDS }));

    await user.click(await screen.findByRole('button', { name: 'Claim all' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Claim 17.67 USDC' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You turned the claim down in your wallet. Nothing was sent.',
    );
  });

  it('claims from a wallet with no account: lowercases ?wallet= and lists room payouts', async () => {
    const user = userEvent.setup();
    wagmi.account = undefined;
    connect.mockResolvedValue({ address: MIXED_CASE, signMessage: vi.fn() });
    const walletClaims: ClaimsResponse = {
      claims: [],
      roomClaims: [
        {
          chainRoundId: '21',
          kind: 'win',
          account: WALLET,
          amount: '9612000',
          proof: PROOF,
          claimsOpenAt: null,
        },
      ],
    };
    const fetch = apiFetch({ 'GET /claims': () => json(200, walletClaims) });
    renderClaims(fetch);

    await user.click(await screen.findByRole('button', { name: 'Connect a wallet' }));

    expect(await screen.findByText('Room round · Won')).toBeInTheDocument();
    // The card's total and the row itself.
    expect(screen.getAllByText('9.61 USDC')).toHaveLength(2);
    const asked = urls(fetch).find((u) => u.includes('/claims'));
    expect(asked).toContain(`wallet=${WALLET}`);
    expect(asked).not.toContain('0x3F2C');
  });

  it('sends the room payout from the connected wallet', async () => {
    const user = userEvent.setup();
    wagmi.account = undefined;
    connect.mockResolvedValue({ address: MIXED_CASE, signMessage: vi.fn() });
    send.mockResolvedValue({ id: '0x1', txHashes: [] });
    renderClaims(
      apiFetch({
        'GET /claims': () =>
          json(200, {
            claims: [],
            roomClaims: [
              {
                chainRoundId: '21',
                kind: 'win',
                account: WALLET,
                amount: '9612000',
                proof: PROOF,
                claimsOpenAt: null,
              },
            ],
          }),
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Connect a wallet' }));
    await user.click(await screen.findByRole('button', { name: 'Claim all' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/One payout, one transaction/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Claim 9.61 USDC' }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![1].account).toBe(WALLET);
    expect(send.mock.calls[0]![1].calls).toHaveLength(1);
  });

  it('owes you nothing when there is nothing to claim', async () => {
    renderClaims(apiFetch({ ...SIGNED_IN, 'GET /claims': () => json(200, { claims: [] }) }));

    expect(await screen.findByText(EMPTY_LINE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Today' })).toBeInTheDocument();
  });
});
