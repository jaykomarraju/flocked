// POST /rounds/:id/entries and room rounds (spec "API" › Reveal gating; W6-F1 R10): a signed-in
// non-member of a room round gets exactly the 404 an unknown round gets, whatever Turnstile token it
// sends (none, a rejected one or an accepted one), and siteverify is never asked. A member still
// meets Turnstile on the first entry of the day.
import { env } from 'cloudflare:test';
import { API_BASE_PATH, newUlid } from '@flocked/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app.js';
import { withAuthDeps } from '../../src/auth/deps.js';
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

let accept = true;
const siteverify = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.resolve(Response.json(accept ? { success: true } : { success: false })),
);
const turnstileEnv = withAuthDeps(env, { turnstileFetch: siteverify });

async function post(userId: string, roundId: string, ciphertext: string, token?: string) {
  const client = withSession(app, fakeUser({ id: userId }));
  const res = await client.request(
    `https://flocked.test${API_BASE_PATH}/rounds/${roundId}/entries`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stake: '25',
        ciphertext,
        ...(token === undefined ? {} : { turnstileToken: token }),
      }),
    },
    turnstileEnv,
  );
  return { status: res.status, body: await res.json<unknown>() };
}

let roomId: string;
let r: TestRound;
let ciphertext: string;
beforeAll(async () => {
  useTestSigner();
  roomId = newUlid();
  r = await createRound({ roomId });
  setClock(BASE_OPENS_AT + HOUR);
  await r.stub.init(r.locked);
  ciphertext = await sealedPick(r.locked);
});

describe('POST /rounds/:id/entries for a room round', () => {
  it('a signed-in non-member gets the unknown-round 404, before Turnstile, whatever the token', async () => {
    const outsider = await createUser(500, roomId, { member: false });
    const unknown = await post(outsider, newUlid(), ciphertext);
    expect(unknown).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    siteverify.mockClear();
    for (const [token, ok] of [
      [undefined, true],
      ['XXXX.DUMMY.TOKEN.XXXX', false],
      ['XXXX.DUMMY.TOKEN.XXXX', true],
    ] as const) {
      accept = ok;
      expect(await post(outsider, r.locked.roundId, ciphertext, token)).toEqual(unknown);
    }
    expect(siteverify).not.toHaveBeenCalled();
    const entered = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE user_id = ?1')
      .bind(outsider)
      .first<{ n: number }>();
    expect(entered?.n).toBe(0);
  });

  it('a member still meets Turnstile on the first entry of the day, then enters', async () => {
    accept = true;
    const member = await createUser(500, roomId);
    expect(await post(member, r.locked.roundId, ciphertext)).toMatchObject({
      status: 403,
      body: { error: { code: 'turnstile_failed' } },
    });
    const res = await post(member, r.locked.roundId, ciphertext, 'XXXX.DUMMY.TOKEN.XXXX');
    expect(res.status).toBe(201);
  });
});
