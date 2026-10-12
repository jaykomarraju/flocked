// The local test seam (src/local/seam.ts): closed unless ENVIRONMENT is 'local' and the per-run key
// is presented; otherwise it creates and locks rounds (or leaves one for the scheduler), pins the
// game clock for the Worker and its DOs, runs a cron expression's jobs, and refuses a reveal with a
// signature that is not the round's beacon. The stack smoke test
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

  // W3-Z carry-over: a closed or unknown seam path reads exactly like the app's unknown path.
  it("answers the app's own 404 body, closed or open", async () => {
    const app = await exports.default.fetch(new Request('https://flocked.test/api/v1/nope'));
    expect(app.status).toBe(404);
    const body = await app.json();
    expect(body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    expect(await (await seam('/nope')).json()).toEqual(body);
    expect(await (await seam('/clock', { nowMs: T }, null)).json()).toEqual(body);
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
      free: { status: 'pending', commitmentRoot: null, lockTx: null, commitTx: null },
      entries: [],
      anchorEvents: [],
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

  it('creates an unlocked daily-shaped round that the scheduler locks on its next tick', async () => {
    await seam('/clock', { nowMs: T });
    const opensAt = T + 60_000;
    const res = await seam('/rounds/scheduled', {
      opensAt,
      closesAt: opensAt + 120_000,
      beaconDelay: 120,
    });
    expect(res.status).toBe(201);
    const { roundId } = await res.json<{ roundId: string }>();
    const row = await env.DB.prepare(
      'SELECT kind, status, locked_at, question_id, config_json FROM rounds WHERE id = ?1',
    )
      .bind(roundId)
      .first<{ kind: string; status: string; locked_at: number | null; config_json: string }>();
    expect(row).toMatchObject({ kind: 'daily', status: 'scheduled', locked_at: null });
    expect(JSON.parse(row?.config_json as string)).toMatchObject({ beaconDelay: 120 });
    // No round_modes until the lock.
    await expectNotFound(await seam(`/rounds/${roundId}`));
    expect((await seam('/rounds/scheduled', { opensAt, closesAt: opensAt })).status).toBe(400);
  });

  it("runs a configured cron expression's jobs and refuses any other", async () => {
    const res = await seam('/cron', { cron: '0 * * * *' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cron: '0 * * * *', jobs: ['create_rounds_ahead'] });
    expect((await seam('/cron', { cron: '5 5 5 5 5' })).status).toBe(400);
  });
});

describe('W6-F1 O1: POST /holds/release (the guardian’s admin action, locally)', () => {
  const hold = (roundId: string) =>
    env.DB.prepare(
      "SELECT released_at, released_by FROM settlement_holds WHERE round_id = ?1 AND mode = 'stakes' AND reason = 'refund_vetoed'",
    )
      .bind(roundId)
      .first<{ released_at: number | null; released_by: string | null }>();
  const audits = (roundId: string) =>
    env.DB.prepare(
      'SELECT actor, actor_user_id, action, target, data_json, created_at FROM audit_log WHERE target = ?1',
    )
      .bind(roundId)
      .all<Record<string, unknown>>()
      .then((r) => r.results);

  it('answers 404 without the key and leaves the hold open', async () => {
    const roundId = newUlid();
    await env.DB.prepare(
      "INSERT INTO settlement_holds (round_id, mode, reason, tx_hash, created_at) VALUES (?1, 'stakes', 'refund_vetoed', NULL, 1)",
    )
      .bind(roundId)
      .run();
    const body = { roundId, mode: 'stakes', reason: 'refund_vetoed' };
    await expectNotFound(await seam('/holds/release', body, null));
    Object.assign(env, { ENVIRONMENT: 'staging' });
    await expectNotFound(await seam('/holds/release', body));
    expect(await hold(roundId)).toEqual({ released_at: null, released_by: null });
    expect(await audits(roundId)).toEqual([]);
  });

  it('with the key, releases an open hold and writes its audit_log row; 404 when none is open', async () => {
    const roundId = newUlid();
    await env.DB.prepare(
      "INSERT INTO settlement_holds (round_id, mode, reason, tx_hash, created_at) VALUES (?1, 'stakes', 'refund_vetoed', NULL, 1)",
    )
      .bind(roundId)
      .run();
    await seam('/clock', { nowMs: T });
    const body = { roundId, mode: 'stakes', reason: 'refund_vetoed' };
    const res = await seam('/holds/release', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roundId,
      mode: 'stakes',
      reason: 'refund_vetoed',
      releasedAt: T,
      releasedBy: 'test-seam',
    });
    expect(await hold(roundId)).toEqual({ released_at: T, released_by: 'test-seam' });
    expect(await audits(roundId)).toEqual([
      {
        actor: 'admin',
        actor_user_id: null,
        action: 'settlement_hold_released',
        target: roundId,
        data_json: JSON.stringify({
          mode: 'stakes',
          reason: 'refund_vetoed',
          releasedBy: 'test-seam',
        }),
        created_at: T,
      },
    ]);

    // Released already, or never held: nothing to release, and no second audit row.
    await expectNotFound(await seam('/holds/release', body));
    await expectNotFound(await seam('/holds/release', { ...body, reason: 'void_rate' }));
    expect(await audits(roundId)).toHaveLength(1);
    expect((await seam('/holds/release', { ...body, reason: 'other' })).status).toBe(400);
  });
});
