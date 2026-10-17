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
import { readStakesPick } from '../stakes/picks';
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
import { useSmartWallet } from '../../wallet/useSmartWallet';
import { useCountingHold } from '../reveal/countingHold';
import detailStyles from '../stakes/details.module.css';
import { showsStakes } from '../stakes/eligibility';
import type { StoredStakesPick } from '../stakes/picks';
import { useStakesToday } from '../stakes/useStakesToday';
import { VerifyCallout } from '../stakes/VerifyCallout';
import { VerifyOverlay } from '../stakes/VerifyOverlay';
import { markRevealPlayed, revealPlayed } from '../reveal/played';
import { RevealView, type RevealPhase } from '../reveal/RevealView';
import { refundKeepsSplit, refundLine } from '../reveal/copy';
import { ShareBlock, shareLink } from '../reveal/ShareBlock';
import { SealedView } from '../sealed/SealedView';
import { formatUsdc } from '../../ui/amounts';
import {
  ROUNDS_TODAY_KEY,
  formatClockTime,
  formatGameDay,
  roundKey,
  roundMe,
  roundMeKey,
  useServerNow,
} from './api';
import { RECEIPT_MISMATCH, crowdHintLine, dstNotice } from './copy';
import { TodayView } from './TodayView';
import { useFreeEntry } from './useFreeEntry';

/**
 * The build-level switch for the Stakes UI (W9-C hid it until wave 10 built the entry flow). It is
 * on now; who actually sees Stakes is `/me`'s eligibility, not this (`features/stakes/eligibility`).
 */
export const STAKES_UI_ENABLED = true;

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

/** What this device and the server know about the player's entry in a round, in either mode. */
function usePlayed(roundId: string | null) {
  const { client, me, status } = useAuth();
  const userId = me?.user.id ?? null;
  const key = userId && roundId ? `${userId}/${roundId}` : null;
  const read = () => (userId && roundId ? readPick(userId, roundId) : null);
  const readStakes = () => (userId && roundId ? readStakesPick(userId, roundId) : null);
  // Read again in the same render the round or user changes, so a round that just became
  // `previousRoundId` never reads as not entered for a render (which would remount its screen).
  const [local, setLocal] = useState(() => ({ key, pick: read(), stakes: readStakes() }));
  let stored = local.pick;
  let storedStakes = local.stakes;
  if (local.key !== key) {
    stored = read();
    storedStakes = readStakes();
    setLocal({ key, pick: stored, stakes: storedStakes });
  }
  const setStored = useCallback(
    (pick: StoredPick) => setLocal((l) => ({ ...l, key, pick })),
    [key],
  );
  const setStoredStakes = useCallback(
    (pick: StoredStakesPick) => setLocal((l) => ({ ...l, key, stakes: pick })),
    [key],
  );
  const mine = useQuery({
    queryKey: roundMeKey(roundId ?? '', userId ?? ''),
    queryFn: ({ signal }) => client.call(roundMe, { params: { id: roundId ?? '' }, signal }),
    enabled: status === 'signed-in' && roundId !== null && userId !== null,
  });
  const entry = mine.data?.modes.free ?? null;
  const stakesEntry = mine.data?.modes.stakes ?? null;
  /** The mode whose reveal the player is shown: Stakes if they played it, else Free. */
  const playedMode: Mode = storedStakes !== null || stakesEntry !== null ? 'stakes' : 'free';
  return {
    userId,
    stored,
    setStored,
    storedStakes,
    setStoredStakes,
    mode: playedMode,
    me: mine.data ?? null,
    refetchMe: mine.refetch,
    entered: stored !== null || entry !== null || storedStakes !== null || stakesEntry !== null,
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
      crowdHint={(mode) => {
        // Free and Stakes tallies are counted separately (spec "Client app" › Today).
        const hint = crowdHint?.[mode];
        return hint ? crowdHintLine(hint) : null;
      }}
      lastRound={lastRound}
      onSealed={cur.setStored}
      onStakesEntered={cur.setStoredStakes}
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
  onStakesEntered,
  onClosed,
}: {
  round: RoundView;
  /** The crowd-history hint for the mode on screen; each mode is counted separately. */
  crowdHint: (mode: Mode) => string | null;
  lastRound: ReactNode;
  onSealed: (pick: StoredPick) => void;
  onStakesEntered: (pick: StoredStakesPick) => void;
  onClosed: () => void;
}) {
  const breakpoint = useBreakpoint();
  const { client, status, me, refresh, miniApp } = useAuth();
  const signIn = useSignIn();
  const online = useOnline();
  const live = useLiveRound(client, round);
  const now = useServerNow(live.round?.skewMs);
  const smartWallet = useSmartWallet();
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
  const entered = useCallback(
    (p: StoredStakesPick) => {
      void refresh();
      onStakesEntered(p);
    },
    [refresh, onStakesEntered],
  );
  const stakes = useStakesToday({
    client,
    wagmi: smartWallet.config,
    me,
    round,
    selected: mode === 'stakes',
    refresh,
    miniApp,
    onEntered: entered,
    wallet: smartWallet.address,
    connect: smartWallet.connect,
  });
  // Entries close for both modes at once, and the Free mode drives the screen's phase.
  const phase = live.round ? modePhase(live.round, 'free', now) : 'open';
  useOnClose(phase === 'open', onClosed);
  const isStakes = mode === 'stakes';
  const stats = live.round?.modes[mode];
  const remainingMs = round.closesAt * 1000 - now;
  const userId = me?.user.id;
  const stakesShown = STAKES_UI_ENABLED && showsStakes(stakes.offer);
  // Stakes hidden by region, age, a break or a suspension: the toggle goes back to Free (AC-8).
  useEffect(() => {
    if (isStakes && !stakesShown) setMode('free');
  }, [isStakes, stakesShown]);

  return (
    <>
      {live.connection === 'reconnecting' ? <OfflineBanner message={RECONNECTING} /> : null}
      <TodayView
        breakpoint={breakpoint}
        date={formatGameDay(round.gameDay)}
        mode={mode}
        onModeChange={setMode}
        stakesAvailable={stakesShown}
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
        crowdHint={crowdHint(mode)}
        stake={
          !isStakes && free
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
        stakesStake={isStakes ? stakes.stakesStake : null}
        callout={isStakes && stakes.offer.kind === 'verify' ? <VerifyCallout /> : null}
        notice={(isStakes ? stakes.notice : null) ?? dstNotice(round.opensAt, round.closesAt)}
        lastRound={lastRound}
        remainingMs={remainingMs}
        entrants={stats?.entrantCount ?? 0}
        pool={stats?.pool ?? 0n}
        live={phase === 'open'}
        signedIn={status === 'signed-in'}
        onSignIn={signIn.open}
        sealing={isStakes ? stakes.pending : entry.state.kind === 'sealing'}
        ctaLabel={isStakes ? stakes.cta.label : undefined}
        ctaLoadingLabel={isStakes ? stakes.cta.loadingLabel : undefined}
        workingNote={isStakes ? stakes.cta.workingNote : undefined}
        sealDisabled={!online || phase !== 'open' || !userId || (isStakes ? stakes.blocked : !free)}
        error={
          (isStakes ? stakes.error : null) ??
          (entry.state.kind === 'error'
            ? {
                message: entry.state.message,
                onRetry: entry.state.known ? undefined : () => entry.reset(),
              }
            : null)
        }
        onSeal={() => {
          if (!userId) return;
          if (isStakes) {
            // "Verify with Coinbase" needs no pick; sealing one does.
            if (stakes.offer.kind === 'verify') return stakes.act(0);
            if (pick === null) return;
            return stakes.act(pick === '1' ? 1 : 0);
          }
          if (pick === null) return;
          void entry.seal({
            round,
            optionIndex: pick === '1' ? 1 : 0,
            stake: BigInt(stake),
            userId,
          });
        }}
      />
      {stakes.details ? (
        <ul className={detailStyles.details}>
          {stakes.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {stakes.verifying && me ? (
        <VerifyOverlay
          breakpoint={breakpoint}
          ageRequired={me.tos.ageRequired}
          onVerify={(age) => void stakes.verify.verify(age)}
          onClose={stakes.closeVerify}
          waiting={
            stakes.verify.state.kind === 'starting' || stakes.verify.state.kind === 'waiting'
          }
          error={stakes.verify.state.kind === 'error' ? stakes.verify.state.message : null}
        />
      ) : null}
    </>
  );
}

/**
 * The player's result card for a revealed or refunded mode, from what the device and the server
 * know. Free counts in points; Stakes in USDC, and until the challenge window closes it is
 * provisional: the card carries "Final at" and names the payout as the amount once final (Paper
 * `core/reveal/provisional/*`). A Free win's amount waits for `/me`'s payouts (decision, Oct 16).
 */
function resultCard(i: {
  mode: Mode;
  phase: RevealPhase;
  optionIndex: number | null;
  winner: number | null;
  counts: readonly [number, number] | null;
  stake: bigint;
  me: RoundMeResponse | null;
  refundReason: number | null;
  /** Stakes before final: the end of the challenge window, as the chip shows it. */
  finalAt?: string;
}): ResultCardProps | null {
  const { mode, phase, counts, stake, me, finalAt } = i;
  const amount = (n: bigint) =>
    mode === 'stakes' ? `${formatUsdc(n)} USDC` : `${n.toLocaleString('en-US')} points`;
  const mine = me?.modes[mode] ?? null;
  const chip = finalAt === undefined ? {} : { finalAt };
  if (phase === 'refunded') {
    return {
      result: 'refunded',
      stake: amount(stake),
      figure: {
        label: finalAt === undefined ? 'Returned' : 'Returned, once final',
        value: amount(stake),
      },
      line: refundLine(i.refundReason),
      ...chip,
    };
  }
  if (phase !== 'revealed' || !counts || i.winner === null) return null;
  const picked = i.optionIndex ?? mine?.entry.optionIndex ?? null;
  if (picked === null) return null;
  const total = counts[0] + counts[1];
  const paid = (mine?.payouts ?? []).reduce((a, p) => a + BigInt(p.amount), 0n);
  const settledMe = mine?.result != null;
  if (picked === i.winner) {
    return {
      result: 'unflocked',
      count: counts[picked] ?? 0,
      total,
      stake: amount(stake),
      figure: {
        // Provisional: the whole payout, not the profit, because it is what Claims will pay.
        label: finalAt === undefined ? 'Won' : 'Payout, once final',
        value: !settledMe ? '…' : finalAt === undefined ? `+${amount(paid - stake)}` : amount(paid),
      },
      ...chip,
    };
  }
  return {
    result: 'got-flocked',
    count: counts[picked] ?? 0,
    total,
    stake: amount(stake),
    figure: { label: 'Lost', value: settledMe ? `−${amount(stake - paid)}` : '…' },
    ...chip,
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
  // The reveal opens on the mode the player played; the toggle switches between them.
  const [mode, setMode] = useState<Mode>(played.mode);
  const bothModes = seed.modes.free !== undefined && seed.modes.stakes !== undefined;
  // "Counting the flock…" is held for 1.5 s, so a result landing a moment after the beacon never
  // skips it. The close still fires on the unheld phase.
  const livePhase = round ? modePhase(round, mode, now) : 'open';
  const phase = useCountingHold(livePhase);
  useOnClose(livePhase === 'open', onClosed);
  const [animate] = useState(() => !revealPlayed(seed.id, mode));
  const current = round?.modes[mode];
  const result = current?.result ?? null;
  // A refunded mode's tally is on GET /rounds/:id only (decision A2): rules 1, 2, 3 and 5 show it.
  const refundDetail = useQuery({
    queryKey: roundKey(seed.id),
    queryFn: ({ signal }) => client.call(roundDetail, { params: { id: seed.id }, signal }),
    enabled: phase === 'refunded',
  });
  const tally =
    result?.tally ??
    (phase === 'refunded'
      ? (refundDetail.data?.round.modes[mode]?.settlement?.tally ?? null)
      : null);
  const counts = tally ? ([tally[0].headcount, tally[1].headcount] as const) : null;
  const { stored, storedStakes, me: mine, refetchMe } = played;
  const entry = mine?.modes[mode] ?? null;
  const device = mode === 'stakes' ? storedStakes : stored;
  const optionIndex = device?.optionIndex ?? entry?.entry.optionIndex ?? null;
  const stake = BigInt(device?.stake ?? entry?.entry.stake ?? '0');
  const settledForMe = entry?.result != null;
  const settled = phase === 'revealed' || phase === 'refunded';
  // A Stakes outcome is provisional until the challenge window closes: the card says when, and a
  // guardian veto turns it into a refund (spec "Real-time and the reveal" › Reveal choreography).
  const finalMs = current?.finalAt ?? current?.claimsOpenAt ?? null;
  const provisional =
    mode === 'stakes' &&
    settled &&
    finalMs !== null &&
    (current?.status === 'settle_proposed' || current?.provisional === true);
  const finalAt = provisional && finalMs !== null ? formatClockTime(finalMs) : undefined;
  // The player played this mode if the device or the server has their entry in it.
  const playedThisMode = device !== null || entry !== null;

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
          mode={mode}
          onModeChange={setMode}
          stakesAvailable={bothModes}
          question={seed.question.prompt}
          pick={optionIndex === null ? null : (options[optionIndex] ?? null)}
          stake={stake}
          revealInMs={seed.beaconTime * 1000 - now}
          entrants={current?.entrantCount ?? 0}
          pool={current?.pool ?? 0n}
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
  const card = playedThisMode
    ? resultCard({
        mode,
        phase: revealPhase,
        optionIndex,
        winner: result?.winningOption ?? null,
        counts,
        stake,
        me: mine,
        refundReason: current?.refundReason ?? null,
        ...(finalAt === undefined ? {} : { finalAt }),
      })
    : null;
  const refunded = revealPhase === 'refunded';
  const hideSplit = refunded && (!counts || !refundKeepsSplit(current?.refundReason ?? null));
  const shareId = mine?.cards.find((c) => c.kind === 'result' && c.mode === mode)?.shareId;
  return (
    <>
      {banner}
      <RevealView
        // A new phase is a new view: the reveal's motion starts when it reaches `revealed`.
        key={revealPhase}
        breakpoint={breakpoint}
        date={date}
        mode={mode}
        onModeChange={setMode}
        stakesAvailable={bothModes}
        question={seed.question.prompt}
        options={options}
        phase={revealPhase}
        unsealingMs={(round?.beaconTime ?? seed.beaconTime) * 1000 - now}
        entrants={current?.entrantCount ?? 0}
        pool={current?.pool ?? 0n}
        pick={optionIndex}
        counts={counts}
        winner={refunded ? null : (result?.winningOption ?? null)}
        hideSplit={hideSplit}
        result={card}
        notPlayed={
          playedThisMode
            ? null
            : {
                onBack: () => setMode(played.mode),
                playedMode: played.mode,
                ...(finalAt === undefined ? {} : { finalAt }),
              }
        }
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
        onPlayed={() => markRevealPlayed(seed.id, mode)}
      />
    </>
  );
}
