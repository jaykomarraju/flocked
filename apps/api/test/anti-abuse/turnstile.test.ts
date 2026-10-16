// Turnstile on the first Free entry of each game day (spec "Anti-abuse"; owner decision Oct 9, 2026):
// POST /rounds/:id/entries requires and verifies `turnstileToken` when the user has no Free entry yet
// in a round closing on that New York date.
import { env } from 'cloudflare:test';
import { API_BASE_PATH, ErrorEnvelopeSchema, gameDayOf, newUlid } from '@flocked/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app.js';
import { withAuthDeps } from '../../src/auth/deps.js';
import { hasFreeEntryOnGameDay } from '../../src/routes/entries.js';
import { fakeUser, withSession } from '../helpers/index.js';
import {
  BASE_OPENS_AT,
  HOUR,
  createRound,
  createUser,
  sealedPick,
  setClock,
  useTestSigner,
  type TestRound,
} from '../round-do/helpers.js';

const siteverify = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.resolve(Response.json({ success: true })),
);
const turnstileEnv = withAuthDeps(env, { turnstileFetch: siteverify });

async function post(userId: string, r: TestRound, extra: Record<string, unknown> = {}) {
  const client = withSession(app, fakeUser({ id: userId }));
  return client.request(
    `https://flocked.test${API_BASE_PATH}/rounds/${r.locked.roundId}/entries`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stake: '25', ciphertext: await sealedPick(r.locked), ...extra }),
    },
    turnstileEnv,
  );
}

const code = async (res: Response) => ErrorEnvelopeSchema.parse(await res.json()).error.code;

let roomId: string;
let a: TestRound;
let b: TestRound;
let next: TestRound;
beforeAll(async () => {
  useTestSigner();
  roomId = newUlid();
  // a and b close on the same New York date; `next` closes the day after. (One room round per room
  // and close time, migration 0019: b closes a second before a.)
  a = await createRound({ roomId });
  b = await createRound({ roomId, opensAt: BASE_OPENS_AT - 1000 });
  next = await createRound({ roomId, opensAt: BASE_OPENS_AT + 24 * HOUR });
  setClock(BASE_OPENS_AT + HOUR);
  for (const r of [a, b, next]) await r.stub.init(r.locked);
});

describe('Turnstile on the first Free entry of the game day', () => {
  it('is required on the first entry: 403 turnstile_failed without a token, and nothing is entered', async () => {
    const u = await createUser(500, roomId);
    const res = await post(u, a);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('turnstile_failed');
    expect(await hasFreeEntryOnGameDay(env.DB, u, a.locked.closesAt)).toBe(false);
  });

  it('a token siteverify accepts lets the first entry through; later entries that day need none', async () => {
    const u = await createUser(500, roomId);
    siteverify.mockClear();
    expect((await post(u, a, { turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' })).status).toBe(201);
    expect(siteverify).toHaveBeenCalledTimes(1);
    const form = siteverify.mock.calls[0]![1]!.body as FormData;
    expect(form.get('response')).toBe('XXXX.DUMMY.TOKEN.XXXX');

    // Another round closing the same New York date: no token, no siteverify call.
    expect(gameDayOf(b.locked.closesAt / 1000)).toBe(gameDayOf(a.locked.closesAt / 1000));
    expect((await post(u, b)).status).toBe(201);
    expect(siteverify).toHaveBeenCalledTimes(1);

    // The next game day asks again.
    setClock(BASE_OPENS_AT + 25 * HOUR);
    try {
      expect(await code(await post(u, next))).toBe('turnstile_failed');
      expect((await post(u, next, { turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' })).status).toBe(201);
    } finally {
      setClock(BASE_OPENS_AT + HOUR);
    }
  });

  it('a token siteverify rejects is 403', async () => {
    const u = await createUser(500, roomId);
    siteverify.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ success: false, 'error-codes': ['invalid-input-response'] })),
    );
    const res = await post(u, a, { turnstileToken: 'bad' });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('turnstile_failed');
  });
});
