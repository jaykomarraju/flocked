// The Claims screen (spec "Client app" › Claims; "API" › `GET /claims`): the caller's unclaimed
// Stakes payouts and refunds — their own and any account merged into them — with the round each one
// came from, what is ready now and when the rest open.
//
//   - Signed in, `GET /claims` takes no query. Signed out, the page offers to connect a wallet and
//     then lists that wallet's claims with `?wallet=0x…` (lowercase: `AddressSchema` takes nothing
//     else), including its room-round payouts, which carry no round data at all.
//   - "Claim all" confirms first (the destination wallet and the payout that isn't open yet need
//     saying), then sends every ready payout as ONE sponsored user operation, so the daily
//     sponsorship cap counts it once.
//   - A payout inside its challenge window is listed with its claim-open time and never counted as
//     ready: the escrow refuses it until the result is final (W7-Z decision D3).
import type { ClaimItem, ClaimsResponse, RoomClaimItem, RoundView } from '@flocked/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Address } from 'viem';
import { getAccount } from 'wagmi/actions';
import { useAuth } from '../../auth/session';
import { connectWallet } from '../../auth/wallet';
import { clientChain } from '../../crypto/chain';
import { useBreakpoint } from '../../theme';
import { ErrorBox } from '../../ui/ErrorBox';
import { Skeleton } from '../../ui/Skeleton';
import { claimCalls, type Claimable } from '../../wallet/calls';
import { sendSponsoredCalls, walletErrorKind } from '../../wallet/send';
import { roundDetail } from '../../ws/useLiveRound';
import { roundKey, useServerNow } from '../today/api';
import { ClaimConfirm, type ConfirmItem } from './ClaimConfirm';
import { ClaimsView, type ClaimRow } from './ClaimsView';
import { claims as claimsEndpoint, claimsKey, walletQuery } from './api';
import {
  PENDING_NOTE,
  ROOM_ROUND,
  claimStatus,
  connectErrorMessage,
  formatClaimDay,
  otherWalletNote,
  readyNote,
  resultWord,
  shortAddress,
  waitingNote,
  walletErrorMessage,
} from './copy';

/** One listed payout: the claim, what its round says (a room payout has no round), and its label. */
interface Entry {
  key: string;
  claim: ClaimItem | RoomClaimItem;
  /** "Wed, Oct 7", or "Room round" for a payout with no round data. */
  date: string;
  gameDay: string | null;
  question: string | null;
  ready: boolean;
}

/** What the batch needs from an entry: `claimCalls` builds `claim`/`claimRefund` from it. */
function claimable(claim: ClaimItem | RoomClaimItem): Claimable {
  return { chainRoundId: claim.chainRoundId, kind: claim.kind, proof: claim.proof };
}

/** The listed payouts, with round data filled in wherever there is any. */
export function claimEntries(
  data: ClaimsResponse | undefined,
  rounds: Map<string, RoundView>,
  now: number,
): Entry[] {
  const isReady = (openAt: number | null) => openAt === null || openAt <= now;
  const own: Entry[] = (data?.claims ?? []).map((claim) => {
    const round = rounds.get(claim.roundId);
    return {
      key: `${claim.roundId}:${claim.kind}:${claim.account}`,
      claim,
      date: round ? formatClaimDay(round.gameDay) : ROOM_ROUND,
      gameDay: round?.gameDay ?? null,
      question: round?.question.prompt ?? null,
      ready: isReady(claim.claimsOpenAt),
    };
  });
  const room: Entry[] = (data?.roomClaims ?? []).map((claim, i) => ({
    key: `room:${claim.chainRoundId}:${claim.kind}:${i}`,
    claim,
    date: ROOM_ROUND,
    gameDay: null,
    question: null,
    ready: isReady(claim.claimsOpenAt),
  }));
  return [...own, ...room];
}

/** The batch: sent, waited for, and turned into a line the player can act on when it fails. */
type ClaimState = { kind: 'idle' } | { kind: 'claiming' } | { kind: 'error'; message: string };

export function Claims() {
  const breakpoint = useBreakpoint();
  const navigate = useNavigate();
  const { status, client, wagmiConfig } = useAuth();
  const signedIn = status === 'signed-in';
  const [wallet, setWallet] = useState<Address | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [claim, setClaim] = useState<ClaimState>({ kind: 'idle' });
  const now = useServerNow();

  const query = useQuery({
    queryKey: claimsKey(wallet),
    queryFn: ({ signal }) =>
      client.call(claimsEndpoint, {
        query: wallet === null ? {} : { wallet: walletQuery(wallet) },
        signal,
      }),
    enabled: signedIn || wallet !== null,
  });

  // The question and the game day live on the round, not on `/claims`, so each listed round is read
  // once, from the public endpoint, under the key the rest of the app already uses for it.
  const roundIds = [...new Set((query.data?.claims ?? []).map((c) => c.roundId))];
  const rounds = useQueries({
    queries: roundIds.map((id) => ({
      queryKey: roundKey(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        client.call(roundDetail, { params: { id }, signal }),
    })),
    combine: (results) => {
      const map = new Map<string, RoundView>();
      for (const r of results) if (r.data) map.set(r.data.round.id, r.data.round);
      return map;
    },
  });

  const entries = claimEntries(query.data, rounds, now);
  const allReady = entries.filter((e) => e.ready);
  // `FlockedEscrow.claim` and `claimRefund` build their leaf from `msg.sender`, so one batch can
  // only claim what the wallet that sends it owns. `/claims` can list payouts belonging to a merged
  // account's wallet too, so "Claim all" takes the connected wallet's and names the rest.
  const connected = (wallet ?? getAccount(wagmiConfig).address)?.toLowerCase() ?? null;
  const claimWallet =
    connected !== null && allReady.some((e) => e.claim.account === connected)
      ? connected
      : (allReady[0]?.claim.account ?? connected);
  const ready = allReady.filter((e) => e.claim.account === claimWallet);
  const elsewhere = allReady.length - ready.length;
  const readyTotal = ready.reduce((sum, e) => sum + BigInt(e.claim.amount), 0n);
  const claiming = claim.kind === 'claiming';
  const refetch = query.refetch;

  const onConnect = useCallback(() => {
    setConnecting(true);
    setClaim({ kind: 'idle' });
    void connectWallet(wagmiConfig)
      .then((signer) => setWallet(signer.address.toLowerCase() as Address))
      .catch((err: unknown) =>
        setClaim({ kind: 'error', message: connectErrorMessage(walletErrorKind(err)) }),
      )
      .finally(() => setConnecting(false));
  }, [wagmiConfig]);

  const claimAll = useCallback(
    async (items: readonly Claimable[]) => {
      setConfirming(false);
      setClaim({ kind: 'claiming' });
      try {
        const chain = clientChain();
        const account = wallet ?? getAccount(wagmiConfig).address;
        await sendSponsoredCalls(wagmiConfig, {
          account: account ?? (await connectWallet(wagmiConfig)).address,
          chainId: chain.chainId,
          calls: claimCalls(chain.escrow, items),
        });
        setClaim({ kind: 'idle' });
        await refetch();
      } catch (err) {
        setClaim({ kind: 'error', message: walletErrorMessage(walletErrorKind(err)) });
      }
    },
    [wallet, wagmiConfig, refetch],
  );

  if (status === 'loading') return <Skeleton />;
  if ((signedIn || wallet !== null) && query.isPending) return <Skeleton />;
  if (query.isError) return <ErrorBox onRetry={() => void refetch()} />;

  const error = claim.kind === 'error' ? claim.message : null;
  if (!signedIn && wallet === null) {
    return (
      <ClaimsView
        breakpoint={breakpoint}
        rows={[]}
        readyTotal={0n}
        note={null}
        wallet={null}
        error={error}
        connect={{ onConnect, connecting }}
      />
    );
  }

  const owner = claimWallet ?? entries[0]?.claim.account ?? wallet ?? null;
  const destination = owner === null ? null : shortAddress(owner);
  const rows: ClaimRow[] = entries.map((e) => ({
    id: e.key,
    date: e.date,
    result: resultWord(e.claim.kind),
    question: e.question,
    amount: BigInt(e.claim.amount),
    status: claimStatus(e.claim.claimsOpenAt, e.ready, claiming && e.ready),
    ready: e.ready,
  }));
  const items: ConfirmItem[] = ready.map((e) => ({
    id: e.key,
    label: `${e.date} · ${resultWord(e.claim.kind)}`,
    amount: BigInt(e.claim.amount),
  }));
  const waiting = entries
    .flatMap((e, index) =>
      e.ready || e.claim.claimsOpenAt === null
        ? []
        : [{ index, opensAt: e.claim.claimsOpenAt, gameDay: e.gameDay }],
    )
    .sort((a, b) => a.opensAt - b.opensAt);
  const next = waiting[0];

  return (
    <ClaimsView
      breakpoint={breakpoint}
      rows={rows}
      readyTotal={readyTotal}
      note={
        claiming
          ? PENDING_NOTE
          : [
              readyNote({ ready: ready.length, total: entries.length, waiting }),
              elsewhere > 0 ? otherWalletNote(elsewhere) : null,
            ]
              .filter((line): line is string => line !== null)
              .join(' ') || null
      }
      wallet={destination}
      claiming={claiming}
      claimDisabled={ready.length === 0}
      error={error}
      onClaimAll={() => setConfirming(true)}
      onBackToToday={() => void navigate('/')}
    >
      <ClaimConfirm
        breakpoint={breakpoint}
        open={confirming}
        onClose={() => setConfirming(false)}
        items={items}
        total={readyTotal}
        wallet={destination}
        waiting={
          next === undefined
            ? null
            : waitingNote({ count: waiting.length, opensAt: next.opensAt, gameDay: next.gameDay })
        }
        claiming={claiming}
        onConfirm={() => void claimAll(ready.map((e) => claimable(e.claim)))}
      />
    </ClaimsView>
  );
}
