// W9-D's registrations of W9-A's notify pieces: the Farcaster webhook is mounted, and the notify
// queue hands a whole batch to `notifyQueueBatch`, so identical Farcaster notifications go out in one
// request.
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import type { NotifyMessage } from '@flocked/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HANDLERS, queue } from '../../src/queues/index.js';
import { seedFixture, type Fixture } from '../helpers/index.js';

const FARCASTER_URL = 'https://api.farcaster.xyz/v1/frame-notifications';

let ids: Fixture['ids'];
let round: string;

beforeAll(async () => {
  const fx = await seedFixture(env.DB);
  ids = fx.ids;
  round = fx.round.id;
  for (const [userId, fid] of [
    [ids.user, 201],
    [ids.otherUser, 202],
  ] as const) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'farcaster', ?3, 1)",
      ).bind(`01K7G${String(fid).padStart(21, '0')}`, userId, String(fid)),
      env.DB.prepare(
        'INSERT INTO farcaster_notification_tokens (fid, app_fid, url, token, updated_at) VALUES (?1, 9152, ?2, ?3, 1)',
      ).bind(fid, FARCASTER_URL, `tok-${fid}`),
    ]);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /farcaster/webhook (W9-D registration)', () => {
  it('is mounted: the Worker answers it, 503 without FARCASTER_HUB_URL (not 404)', async () => {
    const res = await exports.default.fetch(
      new Request('https://flocked.test/api/v1/farcaster/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ header: 'h', payload: 'p', signature: 's' }),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'unavailable' } });
  });
});

describe('the notify queue (W9-D registration)', () => {
  const live = (userId: string, n: number) => ({
    id: `m${n}`,
    timestamp: new Date(1_000),
    attempts: 1,
    body: {
      event: 'question_live',
      userId,
      dedupeKey: `question_live:${round}:${userId}`,
      payload: { roundId: round, gameDay: '2026-10-08' },
    } satisfies NotifyMessage,
  });

  it('sends a batch through notifyQueueBatch: one Farcaster request for both users, both acked', async () => {
    const posted: string[][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(url).toBe(FARCASTER_URL);
      const { tokens } = JSON.parse(init?.body as string) as { tokens: string[] };
      posted.push(tokens);
      return Promise.resolve(
        Response.json({
          result: { successfulTokens: tokens, invalidTokens: [], rateLimitedTokens: [] },
        }),
      );
    });
    const ctx = createExecutionContext();
    const batch = createMessageBatch<unknown>('notify', [
      live(ids.user, 1),
      live(ids.otherUser, 2),
      { id: 'bad', timestamp: new Date(1_000), attempts: 1, body: { event: 'nope' } },
    ]);
    await queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.sort()).toEqual(['tok-201', 'tok-202']);
    expect(result.retryMessages).toEqual([]);
    expect([...result.explicitAcks].sort()).toEqual(['bad', 'm1', 'm2']);
  });

  it('a test that swaps the notify handler still gets the per-message path', async () => {
    const seen: string[] = [];
    const ctx = createExecutionContext();
    const batch = createMessageBatch('notify', [live(ids.user, 3)]);
    await queue(batch, env, ctx, {
      ...HANDLERS,
      notify: (body) => Promise.resolve(void seen.push(body.dedupeKey)),
    });
    expect(seen).toEqual([`question_live:${round}:${ids.user}`]);
  });
});
