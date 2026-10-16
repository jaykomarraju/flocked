// Today (spec "Client app" › Today, Sealed, Reveal; "Real-time and the reveal"): `GET /rounds/today`
// → the skeleton, the error box with a retry, or the screen for where the player stands:
//   - the previous round (`previousRoundId`) is still revealing and the player entered it: its reveal
//     (unsealing, counting, the animation, the result), ending with "The next question is already
//     live"; once they move on, Today for the new round carries a "Last round" strip back to it;
//   - the player entered today's round: Sealed until it closes, then its reveal;
//   - otherwise today's round, open (TodayView), with the Free entry flow behind "Seal my pick".
// Each round is followed live over its WebSocket (counts, close, reveal), polling `GET /rounds/:id`
// with a "Reconnecting" banner while the socket is down. "Entered" means a pick stored on this device
// or an entry `GET /rounds/:id/me` knows about (storage lost: "Pick not on this device").
import type { RoundMeResponse, RoundView, RoundsTodayResponse } from '@flocked/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client';
import { useAuth } from '../../auth/session';
import { readPick, type StoredPick } from '../../crypto/picks';
import { useSignIn } from '../../layout/SignInContext';
import { useOnline } from '../../lib/online';
import { useBreakpoint } from '../../theme';
import { EmptyState } from '../../ui/EmptyState';
import { ErrorBox } from '../../ui/ErrorBox';
import type { Mode } from '../../ui/ModeToggle';
import { OfflineBanner } from '../../ui/OfflineBanner';
import type { ResultCardProps } from '../../ui/ResultCard';
import { Skeleton } from '../../ui/Skeleton';
import { modePhase } from '../../ws/live';
import { roundDetail, useLiveRound } from '../../ws/useLiveRound';
import { LastRoundStrip, lastRoundSummary } from '../reveal/LastRoundStrip';
import { markRevealPlayed, revealPlayed } from '../reveal/played';
import { RevealView, type RevealPhase } from '../reveal/RevealView';
import { refundKeepsSplit, refundLine } from '../reveal/copy';
import { ShareBlock, shareLink } from '../reveal/ShareBlock';
import { SealedView } from '../sealed/SealedView';
import {
  ROUNDS_TODAY_KEY,
  formatGameDay,
  roundKey,
  roundMe,
  roundMeKey,
  useServerNow,
} from './api';
import { RECEIPT_MISMATCH, crowdHintLine, dstNotice } from './copy';
import { TodayView } from './TodayView';
import { useFreeEntry } from './useFreeEntry';

/** Stakes entry is wave 10's: until then the toggle shows the static "Free" label. */
export const STAKES_UI_ENABLED = false;

/** The "Reconnecting" banner while the round socket is down (decision E7). */
export const RECONNECTING = 'Reconnecting…';

export function Today() {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ROUNDS_TODAY_KEY,
    queryFn: ({ signal }) => client.call(api.roundsToday, { signal }),
  });
  if (query.isPending) return <Skeleton />;
  if (query.isError) return <ErrorBox onRetry={() => void query.refetch()} />;
  return <TodayScreen data={query.data} />;
}

/** What this device and the server know about the player's Free entry in a round. */
function usePlayed(roundId: string | null) {
  const { client, me, status } = useAuth();
  const userId = me?.user.id ?? null;
  const key = userId && roundId ? `${userId}/${roundId}` : null;
  const read = () => (userId && roundId ? readPick(userId, roundId) : null);
  // Read again in the same render the round or user changes, so a round that just became
  // `previousRoundId` never reads as not entered for a render (which would remount its screen).
  const [local, setLocal] = useState(() => ({ key, pick: read() }));
  let stored = local.pick;
  if (local.key !== key) {
    stored = read();
    setLocal({ key, pick: stored });
  }
  const setStored = useCallback((pick: StoredPick) => setLocal({ key, pick }), [key]);
  const mine = useQuery({
    queryKey: roundMeKey(roundId ?? '', userId ?? ''),
    queryFn: ({ signal }) => client.call(roundMe, { params: { id: roundId ?? '' }, signal }),
    enabled: status === 'signed-in' && roundId !== null && userId !== null,
  });
  const entry = mine.data?.modes.free ?? null;
  return {
    userId,
    stored,
    setStored,
    me: mine.data ?? null,
    refetchMe: mine.refetch,
    entered: stored !== null || entry !== null,
    /** Still finding out (no stored pick, and the session or the server hasn't answered). */
    pending:
      stored === null && (status === 'loading' || (mine.isPending && mine.fetchStatus !== 'idle')),
  };
}

function TodayScreen({ data }: { data: RoundsTodayResponse }) {
  const { round, previousRoundId, crowdHint } = data;
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [closedReveal, setClosedReveal] = useState<string | null>(null);
  // The API drops `previousRoundId` once the round settles; the reveal on screen stays until the player
  // moves on, and its "Last round" strip for the rest of the visit.
  const [sticky, setSticky] = useState<string | null>(null);
  const prevId = previousRoundId ?? sticky;
  const prev = usePlayed(prevId);
  useEffect(() => {
    if (previousRoundId && prev.entered) setSticky(previousRoundId);
  }, [previousRoundId, prev.entered]);
  const cur = usePlayed(round?.id ?? null);
  // The round last on screen: once it closes, `GET /rounds/today` names it `previousRoundId`, and its
  // `GET /rounds/:id` starts from it, so its screen stays mounted (no skeleton, no second socket).
  const [shown, setShown] = useState(round);
  useEffect(() => {
    if (round) setShown(round);
  }, [round]);
  const prevView = useQuery({
    queryKey: roundKey(prevId ?? ''),
    queryFn: ({ signal }) => client.call(roundDetail, { params: { id: prevId ?? '' }, signal }),
    enabled: prevId !== null && prev.entered,
    placeholderData: shown && shown.id === prevId ? { round: shown } : undefined,
  });
  const refetchToday = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ROUNDS_TODAY_KEY }),
    [queryClient],
  );

  if (prev.pending || cur.pending) return <Skeleton />;

  if (prevId && prev.entered && closedReveal !== prevId) {
    if (prevView.isError) return <ErrorBox onRetry={() => void prevView.refetch()} />;
    if (!prevView.data) return <Skeleton />;
    return (
      <PlayedRound
        key={prevId}
        seed={prevView.data.round}
        played={prev}
        next={round}
        onNext={() => setClosedReveal(prevId)}
        onClosed={refetchToday}
      />
    );
  }
  if (!round) return <EmptyState />;
  if (cur.entered) {
    return (
      <PlayedRound key={round.id} seed={round} played={cur} next={null} onClosed={refetchToday} />
    );
  }
  const lastRound =
    prevId && prev.entered ? (
      <LastRoundStrip
        summary={lastRoundSummary(prev.me, prev.stored)}
        onSee={() => setClosedReveal(null)}
      />
    ) : null;
  return (
    <OpenRound
      key={round.id}
      round={round}
      crowdHint={crowdHint?.free ? crowdHintLine(crowdHint.free) : null}
      lastRound={lastRound}
      onSealed={cur.setStored}
      onClosed={refetchToday}
    />
  );
}

/** Calls `onClosed` once, when the round's entries close on the server's clock. */
function useOnClose(phaseOpen: boolean, onClosed: () => void) {
  const fired = useRef(false);
  useEffect(() => {
    if (!phaseOpen && !fired.current) {
      fired.current = true;
      onClosed();
    }
  }, [phaseOpen, onClosed]);
}

function optionLabel(o: { label: string; emoji: string }): string {
  return o.emoji ? `${o.emoji} ${o.label}` : o.label;
}

function OpenRound({
  round,
  crowdHint,
  lastRound,
  onSealed,
  onClosed,
}: {
  round: RoundView;
  crowdHint: string | null;
  lastRound: ReactNode;
  onSealed: (pick: StoredPick) => void;
  onClosed: () => void;
}) {
  const breakpoint = useBreakpoint();
  const { client, status, me, refresh } = useAuth();
  const signIn = useSignIn();
  const online = useOnline();
  const live = useLiveRound(client, round);
  const now = useServerNow(live.round?.skewMs);
  const [mode, setMode] = useState<Mode>('free');
  const [pick, setPick] = useState<string | null>(null);
  const free = round.config?.free;
  const presets = useMemo(() => (free?.presets ?? []).map(Number), [free]);
  const min = Number(free?.stakeMin ?? 10);
  const max = Number(free?.stakeMax ?? 100);
  const balance = me ? Number(me.balances.global) : undefined;
  const [stake, setStake] = useState(() => presets[1] ?? presets[0] ?? min);
  const sealed = useCallback(
    (p: StoredPick) => {
      void refresh();
      onSealed(p);
    },
    [refresh, onSealed],
  );
  const entry = useFreeEntry(client, sealed);
  const phase = live.round ? modePhase(live.round, 'free', now) : 'open';
  useOnClose(phase === 'open', onClosed);
  const stats = live.round?.modes.free;
  const remainingMs = round.closesAt * 1000 - now;
  const userId = me?.user.id;

  return (
    <>
      {live.connection === 'reconnecting' ? <OfflineBanner message={RECONNECTING} /> : null}
      <TodayView
        breakpoint={breakpoint}
        date={formatGameDay(round.gameDay)}
        mode={mode}
        onModeChange={setMode}
        stakesAvailable={STAKES_UI_ENABLED && round.modes.stakes !== undefined}
        question={round.question.prompt}
        options={round.question.options.map((o, i) => ({
          value: String(i),
          label: optionLabel(o),
        }))}
        pick={pick}
        onPick={(v) => {
          setPick(v);
          entry.reset();
        }}
        crowdHint={crowdHint}
        stake={
          free
            ? {
                value: stake,
                onChange: (v) => {
                  setStake(v);
                  entry.reset();
                },
                min,
                max,
                presets,
                balance,
              }
            : null
        }
        notice={dstNotice(round.opensAt, round.closesAt)}
        lastRound={lastRound}
        remainingMs={remainingMs}
        entrants={stats?.entrantCount ?? 0}
        pool={stats?.pool ?? 0n}
        live={phase === 'open'}
        signedIn={status === 'signed-in'}
        onSignIn={signIn.open}
        sealing={entry.state.kind === 'sealing'}
        sealDisabled={!online || phase !== 'open' || !free || !userId}
        error={
          entry.state.kind === 'error'
            ? {
                message: entry.state.message,
                onRetry: entry.state.known ? undefined : () => entry.reset(),
              }
            : null
        }
        onSeal={() => {
          if (pick === null || !userId) return;
          void entry.seal({
            round,
            optionIndex: pick === '1' ? 1 : 0,
            stake: BigInt(stake),
            userId,
          });
        }}
      />
    </>
  );
}

/** The player's result card for a revealed or refunded Free mode, from what the device and server know. */
function resultCard(
  phase: RevealPhase,
  optionIndex: number | null,
  winner: number | null,
  counts: readonly [number, number] | null,
  stake: bigint,
  me: RoundMeResponse | null,
  refundReason: number | null,
): ResultCardProps | null {
  const points = (n: bigint) => `${n.toLocaleString('en-US')} points`;
  if (phase === 'refunded') {
    return {
      result: 'refunded',
      stake: points(stake),
      figure: { label: 'Returned', value: points(stake) },
      line: refundLine(refundReason),
    };
  }
  if (phase !== 'revealed' || !counts || winner === null) return null;
  const mine = optionIndex ?? me?.modes.free?.entry.optionIndex ?? null;
  if (mine === null) return null;
  const total = counts[0] + counts[1];
  const paid = (me?.modes.free?.payouts ?? []).reduce((a, p) => a + BigInt(p.amount), 0n);
  const settledMe = me?.modes.free?.result != null;
  if (mine === winner) {
    return {
      result: 'unflocked',
      count: counts[mine] ?? 0,
      total,
      stake: points(stake),
      figure: { label: 'Won', value: settledMe ? `+${points(paid - stake)}` : '…' },
    };
  }
  return {
    result: 'got-flocked',
    count: counts[mine] ?? 0,
    total,
    stake: points(stake),
    figure: { label: 'Lost', value: settledMe ? `−${points(stake - paid)}` : '…' },
  };
}

function PlayedRound({
  seed,
  played,
  next,
  onNext,
  onClosed,
}: {
  seed: RoundView;
  played: ReturnType<typeof usePlayed>;
  next: RoundView | null;
  onNext?: () => void;
  onClosed: () => void;
}) {
  const breakpoint = useBreakpoint();
  const navigate = useNavigate();
  const { client, me } = useAuth();
  const live = useLiveRound(client, seed);
  const now = useServerNow(live.round?.skewMs);
  const round = live.round;
  const phase = round ? modePhase(round, 'free', now) : 'open';
  useOnClose(phase === 'open', onClosed);
  const [animate] = useState(() => !revealPlayed(seed.id, 'free'));
  const free = round?.modes.free;
  const result = free?.result ?? null;
  // A refunded mode's tally is on GET /rounds/:id only (decision A2): rules 1, 2, 3 and 5 show it.
  const refundDetail = useQuery({
    queryKey: roundKey(seed.id),
    queryFn: ({ signal }) => client.call(roundDetail, { params: { id: seed.id }, signal }),
    enabled: phase === 'refunded',
  });
  const tally =
    result?.tally ??
    (phase === 'refunded'
      ? (refundDetail.data?.round.modes.free?.settlement?.tally ?? null)
      : null);
  const counts = tally ? ([tally[0].headcount, tally[1].headcount] as const) : null;
  const { stored, me: mine, refetchMe } = played;
  const entry = mine?.modes.free ?? null;
  const optionIndex = stored?.optionIndex ?? entry?.entry.optionIndex ?? null;
  const stake = BigInt(stored?.stake ?? entry?.entry.stake ?? '0');
  const settledForMe = entry?.result != null;
  const settled = phase === 'revealed' || phase === 'refunded';

  // After the reveal the per-entry rows follow: ask again until the player's result is in.
  useEffect(() => {
    if (!settled || settledForMe) return;
    void refetchMe();
    const timer = setInterval(() => void refetchMe(), 3000);
    return () => clearInterval(timer);
  }, [settled, settledForMe, refetchMe]);

  const date = formatGameDay(seed.gameDay);
  const options = seed.question.options.map(optionLabel);
  const banner =
    live.connection === 'reconnecting' ? <OfflineBanner message={RECONNECTING} /> : null;

  if (phase === 'open') {
    return (
      <>
        {banner}
        <SealedView
          breakpoint={breakpoint}
          date={date}
          mode="free"
          onModeChange={() => undefined}
          stakesAvailable={false}
          question={seed.question.prompt}
          pick={optionIndex === null ? null : (options[optionIndex] ?? null)}
          stake={stake}
          revealInMs={seed.beaconTime * 1000 - now}
          entrants={free?.entrantCount ?? 0}
          pool={free?.pool ?? 0n}
          live
          mismatch={stored && stored.mismatches.length > 0 ? RECEIPT_MISMATCH : null}
          onRemind={() => void navigate('/settings')}
          onInvite={() =>
            void shareLink(
              `${window.location.origin}/${me ? `?ref=${me.user.refCode}` : ''}`,
              'Flocked',
            )
          }
        />
      </>
    );
  }

  const revealPhase: RevealPhase = phase;
  const card = resultCard(
    revealPhase,
    optionIndex,
    result?.winningOption ?? null,
    counts,
    stake,
    mine,
    free?.refundReason ?? null,
  );
  const refunded = revealPhase === 'refunded';
  const hideSplit = refunded && (!counts || !refundKeepsSplit(free?.refundReason ?? null));
  const shareId = mine?.cards.find((c) => c.kind === 'result' && c.mode === 'free')?.shareId;
  return (
    <>
      {banner}
      <RevealView
        // A new phase is a new view: the reveal's motion starts when it reaches `revealed`.
        key={revealPhase}
        breakpoint={breakpoint}
        date={date}
        mode="free"
        onModeChange={() => undefined}
        stakesAvailable={false}
        question={seed.question.prompt}
        options={options}
        phase={revealPhase}
        unsealingMs={(round?.beaconTime ?? seed.beaconTime) * 1000 - now}
        entrants={free?.entrantCount ?? 0}
        pool={free?.pool ?? 0n}
        pick={optionIndex}
        counts={counts}
        winner={refunded ? null : (result?.winningOption ?? null)}
        hideSplit={hideSplit}
        result={card}
        share={
          // Share with a split to show: a settled result, or a refund that keeps its split (Paper).
          card && counts && (card.result !== 'refunded' || !hideSplit) ? (
            <ShareBlock
              breakpoint={breakpoint}
              question={seed.question.prompt}
              counts={counts}
              winner={result?.winningOption ?? null}
              result={card.result}
              handle={me?.user.handle ?? null}
              url={`${window.location.origin}${shareId ? `/s/${shareId}` : `/r/${seed.id}`}`}
            />
          ) : null
        }
        next={
          next && onNext
            ? {
                question: next.question.prompt,
                remainingMs: next.closesAt * 1000 - now,
                onOpen: onNext,
              }
            : null
        }
        animate={animate}
        onPlayed={() => markRevealPlayed(seed.id, 'free')}
      />
    </>
  );
}
