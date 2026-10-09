// The local test seam (src/local/seam.ts): closed unless ENVIRONMENT is 'local' and the per-run key
// is presented; otherwise it creates and locks rounds, pins the game clock for the Worker and its
// DOs, and refuses a reveal with a signature that is not the round's beacon. The stack smoke test
// (e2e/tests/stack-smoke.test.ts) covers the full flow with a real drand network.
import { exports } from 'cloudflare:workers';
import { env } from 'cloudflare:test';
import { ErrorEnvelopeSchema, newUlid } from '@flocked/shared';
import { beaconTime, chainFromEnv, firstRoundAtOrAfter } from '@flocked/tlock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seamEnabled } from '../src/local/seam.js';

const KEY = 'a'.repeat(64);
const chain = chainFromEnv(env as unknown as Record<string, string | undefined>);
const T = Date.UTC(2026, 9, 8, 16, 0, 0);

function seam(path: string, body?: unknown, key: string | null = KEY): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://flocked.test/__test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function expectNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(ErrorEnvelopeSchema.parse(await res.json()).error.code).toBe('not_found');
}

const saved = { ...env };
beforeEach(() => {
  Object.assign(env, { ENVIRONMENT: 'local', FLOCKED_TEST_SEAM_KEY: KEY });
});
afterEach(() => {
  for (const k of ['FLOCKED_TEST_SEAM_KEY', 'FLOCKED_TEST_CLOCK'] as const) delete env[k];
  Object.assign(env, { ENVIRONMENT: saved.ENVIRONMENT });
});

describe('guard', () => {
  it('is enabled only in local with a key', () => {
    expect(seamEnabled({ ENVIRONMENT: 'local', FLOCKED_TEST_SEAM_KEY: KEY })).toBe(true);
    expect(seamEnabled({ ENVIRONMENT: 'local' })).toBe(false);
    expect(seamEnabled({ ENVIRONMENT: 'staging', FLOCKED_TEST_SEAM_KEY: KEY })).toBe(false);
    expect(seamEnabled({ ENVIRONMENT: 'production', FLOCKED_TEST_SEAM_KEY: KEY })).toBe(false);
  });

  it.each(['staging', 'production'] as const)('answers 404 in %s, even with the key', async (e) => {
    Object.assign(env, { ENVIRONMENT: e });
    await expectNotFound(await seam('/clock', { nowMs: T }));
    expect(env.FLOCKED_TEST_CLOCK).toBeUndefined();
  });

  it('answers 404 without the key, with a wrong key, and when no key is configured', async () => {
    await expectNotFound(await seam('/clock', { nowMs: T }, null));
    await expectNotFound(await seam('/clock', { nowMs: T }, 'b'.repeat(64)));
    delete env.FLOCKED_TEST_SEAM_KEY;
    await expectNotFound(await seam('/clock', { nowMs: T }));
    expect(env.FLOCKED_TEST_CLOCK).toBeUndefined();
  });

  it('answers 404 for unknown seam paths', async () => {
    await expectNotFound(await seam('/nope'));
  });
});

describe('with the key, in local', () => {
  it('pins the game clock and releases it', async () => {
    const pinned = await seam('/clock', { nowMs: T });
    expect(await pinned.json()).toEqual({ nowMs: T });
    expect(env.FLOCKED_TEST_CLOCK).toBe(String(T));
    await seam('/clock', { nowMs: null });
    expect(env.FLOCKED_TEST_CLOCK).toBeUndefined();
  });

  it('rejects a clock that is not whole seconds', async () => {
    const res = await seam('/clock', { nowMs: T + 1 });
    expect(res.status).toBe(400);
  });

  it('creates a locked daily Free round targeting the first beacon after closesAt + beaconDelay', async () => {
    await seam('/clock', { nowMs: T });
    const closesAt = T + 60_000;
    const res = await seam('/rounds', { opensAt: T - 60_000, closesAt, beaconDelay: 60 });
    expect(res.status).toBe(201);
    const body = await res.json<{
      locked: { roundId: string; beaconRound: number; beaconTimeSec: number; kind: string };
      state: { status: string };
    }>();
    const beaconRound = firstRoundAtOrAfter(chain, closesAt / 1000 + 60);
    expect(body.locked).toMatchObject({
      kind: 'daily',
      beaconRound,
      beaconTimeSec: beaconTime(chain, beaconRound),
    });
    // The pinned clock is past opensAt, so init opened it.
    expect(body.state.status).toBe('open');

    const read = await seam(`/rounds/${body.locked.roundId}`);
    expect(await read.json()).toMatchObject({
      status: 'open',
      free: { status: 'pending', commitmentRoot: null },
      entries: [],
    });

    const reveal = await seam(`/rounds/${body.locked.roundId}/reveal`, {
      signature: 'ab'.repeat(48),
    });
    expect(reveal.status).toBe(400);
  });

  it('refuses a round that closes before it opens, and answers 404 for an unknown round', async () => {
    expect((await seam('/rounds', { opensAt: T, closesAt: T - 1000 })).status).toBe(400);
    await expectNotFound(await seam(`/rounds/${newUlid()}`));
  });
});
