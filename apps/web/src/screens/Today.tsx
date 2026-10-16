// Today (spec "Client app" › Today), interim: `GET /rounds/today` → the skeleton while it loads, the
// error box with a retry, the empty state in a schedule gap, else the open round (TodayView) with the
// countdown ticking to close. W9-C builds the entry flow (stake selector, sealing, Sealed, Reveal).
import type { RoundView } from '@flocked/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/session';
import { useSignIn } from '../layout/SignInContext';
import { useBreakpoint } from '../theme';
import { EmptyState } from '../ui/EmptyState';
import { ErrorBox } from '../ui/ErrorBox';
import type { Mode } from '../ui/ModeToggle';
import { Skeleton } from '../ui/Skeleton';
import { TodayView } from './TodayView';

export const ROUNDS_TODAY_KEY = ['rounds', 'today'] as const;

/** A game day ("2026-10-08") as the date line shows it: "Thursday, Oct 8". */
export function formatGameDay(gameDay: string): string {
  const [y = 0, m = 1, d = 1] = gameDay.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** The time now, updated every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function Today() {
  const { client } = useAuth();
  const query = useQuery({
    queryKey: ROUNDS_TODAY_KEY,
    queryFn: ({ signal }) => client.call(api.roundsToday, { signal }),
  });
  if (query.isPending) return <Skeleton />;
  if (query.isError) return <ErrorBox onRetry={() => void query.refetch()} />;
  const { round } = query.data;
  if (!round) return <EmptyState />;
  return <OpenRound key={round.id} round={round} />;
}

function OpenRound({ round }: { round: RoundView }) {
  const breakpoint = useBreakpoint();
  const { status } = useAuth();
  const signIn = useSignIn();
  const now = useNow(1000);
  const [mode, setMode] = useState<Mode>(round.modes.free ? 'free' : 'stakes');
  const [pick, setPick] = useState<string | null>(null);
  const remainingMs = round.closesAt * 1000 - now;
  const stats = round.modes[mode];
  return (
    <TodayView
      breakpoint={breakpoint}
      date={formatGameDay(round.gameDay)}
      mode={mode}
      onModeChange={setMode}
      stakesAvailable={round.modes.stakes !== undefined && round.modes.free !== undefined}
      question={round.question.prompt}
      options={round.question.options.map((o, i) => ({
        value: String(i),
        label: o.emoji ? `${o.emoji} ${o.label}` : o.label,
      }))}
      pick={pick}
      onPick={setPick}
      // The crowd-history hint isn't served yet (GET /rounds/today has no field for it): hidden.
      crowdHint={null}
      remainingMs={remainingMs}
      entrants={stats?.entrantCount ?? 0}
      pool={BigInt(stats?.pool ?? '0')}
      live={round.status === 'open' && remainingMs > 0}
      signedIn={status === 'signed-in'}
      onSignIn={signIn.open}
      // Interim: sealing (tlock, the receipt, the Stakes user operation) is W9-C's entry flow, so
      // "Seal my pick" stays disabled even after a pick rather than offering a press that can't work.
      sealDisabled
    />
  );
}
