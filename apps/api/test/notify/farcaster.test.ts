// Farcaster mini app notifications (src/notify/channels/farcaster.ts): identical notifications batch
// into requests of up to 100 tokens; rate-limited tokens are retried, invalid ones disabled; and the
// consumer's batch sends one request for many users.
import { env } from 'cloudflare:test';
import type { NotifyMessage } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { farcasterChannel, notificationIdFor } from '../../src/notify/channels/farcaster.js';
import { notifyBatch } from '../../src/notify/consumer.js';
import type { Delivery, FarcasterTarget, Recipient } from '../../src/notify/types.js';
import { seedFixture, type Fixture } from '../helpers/index.js';
import { T, fakeChannel } from './helpers.js';

interface Sent {
  url: string;
  notificationId: string;
  title: string;
  body: string;
  targetUrl: string;
  tokens: string[];
}

/** A client endpoint: tokens starting "invalid-" are invalid, "rl-" rate limited (once each by default). */
function client(opts: { status?: number; rateLimitAlways?: boolean } = {}) {
  const sent: Sent[] = [];
  const limited = new Set<string>();
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Omit<Sent, 'url'>;
    const url = input instanceof Request ? input.url : input.toString();
    sent.push({ url, ...body });
    if (opts.status) return Promise.resolve(new Response('{}', { status: opts.status }));
    const result = {
      successfulTokens: [] as string[],
      invalidTokens: [] as string[],
      rateLimitedTokens: [] as string[],
    };
    for (const t of body.tokens) {
      if (t.startsWith('invalid-')) result.invalidTokens.push(t);
      else if (t.startsWith('rl-') && (opts.rateLimitAlways || !limited.has(t))) {
        limited.add(t);
        result.rateLimitedTokens.push(t);
      } else result.successfulTokens.push(t);
    }
    return Promise.resolve(Response.json({ result }));
  };
  return { sent, fetch: fetchFn };
}

const recipient = (userId: string, tokens: FarcasterTarget[]): Recipient => ({
  userId,
  excluded: false,
  email: null,
  pushSubscriptions: [],
  farcasterTokens: tokens,
  prefs: new Map(),
});

const target = (
  token: string,
  url = 'https://api.farcaster.xyz/v1/frame-notifications',
): FarcasterTarget => ({
  fid: 1,
  appFid: 9152,
  url,
  token,
});

const live = (userId: string, tokens: FarcasterTarget[]): Delivery<'farcaster'> => ({
  event: 'question_live',
  dedupeKey: `question_live:01K70000000000000000000020:${userId}`,
  recipient: recipient(userId, tokens),
  copy: { title: "Today's question is live", body: 'Pineapple on pizza?' },
  targetUrl: 'https://flocked.xyz/',
});

const uid = (i: number) => `01K7U${String(i).padStart(21, '0')}`;

describe('farcasterChannel: rate-limit batching', () => {
  it('sends one identical notification to 250 users as 100 + 100 + 50 tokens under one notification ID', async () => {
    const c = client();
    const disabled: string[] = [];
    const ch = farcasterChannel({
      fetch: c.fetch,
      disableTokens: (ts) => Promise.resolve(void disabled.push(...ts.map((t) => t.token))),
    });
    const batch = Array.from({ length: 250 }, (_, i) => live(uid(i), [target(`tok-${i}`)]));
    expect(await ch.send(batch)).toEqual({ retry: [] });
    expect(c.sent.map((s) => s.tokens.length)).toEqual([100, 100, 50]);
    expect(new Set(c.sent.map((s) => s.notificationId))).toEqual(
      new Set(['question_live:01K70000000000000000000020']),
    );
    expect(c.sent[0]).toMatchObject({
      title: "Today's question is live",
      body: 'Pineapple on pizza?',
      targetUrl: 'https://flocked.xyz/',
    });
    expect(new Set(c.sent.flatMap((s) => s.tokens)).size).toBe(250);
    expect(disabled).toEqual([]);
  });

  it('retries a user whose only token was rate limited, not one another client reached; disables invalid tokens', async () => {
    const c = client({ rateLimitAlways: true });
    const disabled: string[] = [];
    const ch = farcasterChannel({
      fetch: c.fetch,
      disableTokens: (ts) => Promise.resolve(void disabled.push(...ts.map((t) => t.token))),
    });
    const out = await ch.send([
      live(uid(1), [target('rl-a')]),
      live(uid(2), [target('rl-b'), target('ok-b', 'https://client.base.org/notify')]),
      live(uid(3), [target('invalid-c')]),
      live(uid(4), [target('ok-d')]),
    ]);
    expect(out.retry).toEqual([`question_live:01K70000000000000000000020:${uid(1)}`]);
    expect(disabled).toEqual(['invalid-c']);
    // Two endpoints: one request each.
    expect(c.sent.map((s) => s.url).sort()).toEqual([
      'https://api.farcaster.xyz/v1/frame-notifications',
      'https://client.base.org/notify',
    ]);
  });

  it('different copy goes in separate requests; a 5xx retries every delivery in it, a 4xx none', async () => {
    const c = client();
    const ch = farcasterChannel({ fetch: c.fetch, disableTokens: () => Promise.resolve() });
    const other = {
      ...live(uid(2), [target('tok-2')]),
      copy: { title: 'An hour left', body: 'x' },
    };
    await ch.send([live(uid(1), [target('tok-1')]), other]);
    expect(c.sent).toHaveLength(2);

    const down = farcasterChannel({
      fetch: client({ status: 503 }).fetch,
      disableTokens: () => Promise.resolve(),
    });
    expect((await down.send([live(uid(1), [target('t1')])])).retry).toHaveLength(1);
    const refused = farcasterChannel({
      fetch: client({ status: 400 }).fetch,
      disableTokens: () => Promise.resolve(),
    });
    expect((await refused.send([live(uid(1), [target('t1')])])).retry).toEqual([]);
  });

  it('the notification ID drops the user only for per-user keys', () => {
    expect(notificationIdFor({ event: 'outcome', dedupeKey: `outcome:2026-10-08:${uid(1)}` })).toBe(
      'outcome:2026-10-08',
    );
    expect(
      notificationIdFor({ event: 'security_notice', dedupeKey: 'security_notice:01K7N' }),
    ).toBe('security_notice:01K7N');
    expect(
      notificationIdFor({ event: 'question_used', dedupeKey: 'question_used:01K7Q:settled' }),
    ).toBe('question_used:01K7Q:settled');
  });
});

describe('notifyBatch with Farcaster tokens in D1', () => {
  let ids: Fixture['ids'];
  let round: string;
  beforeAll(async () => {
    const fx = await seedFixture(env.DB);
    ids = fx.ids;
    round = fx.round.id;
    const fids: [string, number, string][] = [
      [ids.user, 101, 'rl-user'],
      [ids.otherUser, 102, 'ok-other'],
      [ids.admin, 103, 'invalid-admin'],
    ];
    for (const [userId, fid, token] of fids) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES (?1, ?2, 'farcaster', ?3, 1)",
        ).bind(`01K7F${String(fid).padStart(21, '0')}`, userId, String(fid)),
        env.DB.prepare(
          "INSERT INTO farcaster_notification_tokens (fid, app_fid, url, token, updated_at) VALUES (?1, 9152, 'https://api.farcaster.xyz/v1/frame-notifications', ?2, 1)",
        ).bind(fid, token),
      ]);
    }
  });

  it('one request for the batch; the rate-limited user retries alone and is sent once; invalid tokens are disabled', async () => {
    const c = client();
    const channel = farcasterChannel({
      fetch: c.fetch,
      disableTokens: async (ts) => {
        for (const x of ts) {
          await env.DB.prepare(
            'UPDATE farcaster_notification_tokens SET enabled = 0 WHERE url = ?1 AND token = ?2',
          )
            .bind(x.url, x.token)
            .run();
        }
      },
    });
    const deps = {
      channels: { farcaster: channel, webpush: fakeChannel('webpush', () => false) },
      origin: 'https://flocked.xyz',
      now: () => T,
    };
    const msg = (userId: string): NotifyMessage => ({
      event: 'question_live',
      userId,
      dedupeKey: `question_live:${round}:${userId}`,
      payload: { roundId: round, gameDay: '2026-10-08' },
    });
    const batch = [msg(ids.user), msg(ids.otherUser), msg(ids.admin)];
    expect(await notifyBatch(batch, env, deps)).toEqual(['retry', 'ok', 'ok']);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]?.tokens.sort()).toEqual(['invalid-admin', 'ok-other', 'rl-user']);
    expect(
      await env.DB.prepare(
        'SELECT token FROM farcaster_notification_tokens WHERE enabled = 0',
      ).all(),
    ).toMatchObject({ results: [{ token: 'invalid-admin' }] });

    // The queue redelivers the whole batch after its retry delay: only the retried user is sent.
    expect(await notifyBatch(batch, env, deps)).toEqual(['ok', 'ok', 'ok']);
    expect(c.sent).toHaveLength(2);
    expect(c.sent[1]?.tokens).toEqual(['rl-user']);
    expect(await notifyBatch(batch, env, deps)).toEqual(['ok', 'ok', 'ok']);
    expect(c.sent).toHaveLength(2);
  });
});
