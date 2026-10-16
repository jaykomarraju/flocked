// Test helpers for the shell and its screens (Vitest only; nothing in the app imports this): the
// real route table in a memory router under the real session, with the API answered by a stub
// `fetch`, and the breakpoint and connectivity jsdom can't change on its own.
import { RoundsTodayResponseSchema, type RoundsTodayResponse } from '@flocked/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import roundsFixtures from '../../../../packages/shared/test/fixtures/api/rounds.json';
import { AuthProvider } from '../auth/session';
import { createWagmiConfig } from '../auth/wallet';
import { routes } from '../routes';
import { json, ME } from '../test/fixtures';
import type { Breakpoint } from '../theme';

/** `GET /rounds/today` with an open round ("Pineapple on pizza?", game day 2026-10-08). */
export const TODAY: RoundsTodayResponse = RoundsTodayResponseSchema.parse(
  roundsFixtures.valid.RoundsTodayResponseSchema[0],
);

export const UNAUTHORIZED = () =>
  json(401, { error: { code: 'unauthorized', message: 'Sign in' } });

/** An API answer: a response, or a function of the request that makes one. */
export type Answer = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/**
 * A stub `fetch` answering `"<METHOD> <path>"` (the path after /api/v1). Defaults: signed out,
 * no round today, logout ok. Anything else is a 404.
 */
export function apiFetch(answers: Record<string, Answer> = {}) {
  const all: Record<string, Answer> = {
    'GET /me': UNAUTHORIZED,
    'GET /rounds/today': () => json(200, { round: null, previousRoundId: null }),
    'POST /auth/logout': () => json(200, { ok: true }),
    ...answers,
  };
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const answer = all[`${init?.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v1/, '')}`];
    return answer
      ? answer(url, init)
      : json(404, { error: { code: 'not_found', message: 'Not found' } });
  });
}

/** Signed in as ME (`woolly`, 1,240 points). */
export const SIGNED_IN = { 'GET /me': () => json(200, ME) };

const wagmiConfig = createWagmiConfig();

/** Renders the app's routes at `path` with the session over `fetch`. */
export function renderApp({
  path = '/',
  fetch = apiFetch(),
}: { path?: string; fetch?: typeof globalThis.fetch } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider wagmiConfig={wagmiConfig} fetch={fetch} origin="http://app.test">
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, fetch };
}

/** Answers the breakpoint media queries (min-width 768 and 1120) for `breakpoint`. */
export function setBreakpoint(breakpoint: Breakpoint) {
  const width = breakpoint === 'desktop' ? 1120 : breakpoint === 'tablet' ? 768 : 380;
  return vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity) <= width,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

/** Makes `navigator.onLine` answer `online` and tells the page. */
export function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}
