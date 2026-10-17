// The endpoints Today, Sealed and Reveal call beyond `api` (src/api/client.ts), and their query keys.
import {
  CreateEntryRequestSchema,
  CreateEntryResponseSchema,
  RoundMeResponseSchema,
} from '@flocked/shared';
import { useEffect, useState } from 'react';
import { endpoint } from '../../api/client';

export const createEntry = endpoint(
  'POST',
  '/rounds/:id/entries',
  CreateEntryRequestSchema,
  CreateEntryResponseSchema,
);
export const roundMe = endpoint('GET', '/rounds/:id/me', null, RoundMeResponseSchema);

export const ROUNDS_TODAY_KEY = ['rounds', 'today'] as const;
export const roundKey = (id: string) => ['rounds', id] as const;
export const roundMeKey = (id: string, userId: string) => ['rounds', id, 'me', userId] as const;

/** The time now on the server's clock (`skewMs` from the socket's `state`), updated every second. */
export function useServerNow(skewMs = 0, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now + skewMs;
}

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
