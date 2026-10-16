// The RoundDO's timed notifications (src/notify/alarms.ts through src/rounds/hooks.ts) and the daily
// cast (src/notify/cast.ts): who gets each one, their keys, and once-only sends after a double fire.
import { env } from 'cloudflare:test';
import type { NotifyMessage } from '@flocked/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { roundNotifications } from '../../src/notify/alarms.js';
import { postDailyCast, type CastPoster } from '../../src/notify/cast.js';
import { notifyBatch } from '../../src/notify/consumer.js';
import { enqueueNotifications, type HookRound } from '../../src/rounds/hooks.js';
import { FIXTURE_ROUND, seedFixture, type Fixture } from '../helpers/index.js';
import { T, exclude, fakeDeps, seedEntry, setPref } from './helpers.js';

let ids: Fixture['ids'];
let round: HookRound;
const PREV = '01K70000000000000000000019';
const EX = '01K70000000000000000000051';
const NOPREF = '01K70000000000000000000052';

async function user(id: string, handle: string) {
  await env.DB.prepare(
    "INSERT INTO users (id, handle, display_name, role, ref_code, created_at) VALUES (?1, ?2, ?2, 'user', ?3, 1)",
  )
    .bind(id, handle, `REF${handle.toUpperCase()}`)
    .run();
}

async function pushSub(userId: string, n: number) {
  await env.DB.prepare(
    'INSERT INTO push_subscriptions (id, user_id, endpoint, keys_json) VALUES (?1, ?2, ?3, \'{"p256dh":"k","auth":"a"}\')',
  )
    .bind(`01K7S${String(n).padStart(21, '0')}`, userId, `https://fcm.googleapis.com/fcm/send/${n}`)
    .run();
}

async function streak(userId: string, mode: 'free' | 'stakes', n: number) {
  await env.DB.prepare(
    `INSERT INTO user_stats (user_id, mode, stray_streak, best_stray_streak, updated_at) VALUES (?1, ?2, ?3, ?3, 1)`,
  )
    .bind(userId, mode, n)
    .run();
}

beforeAll(async () => {
  const fx = await seedFixture(env.DB);
  ids = fx.ids;
  round = {
    roundId: fx.round.id,
    kind: 'daily',
    roomId: null,
    opensAt: fx.round.opensAt,
    closesAt: fx.round.closesAt,
    modes: ['free', 'stakes'],
  };
  // Yesterday's daily round closed as this one opened.
  await env.DB.prepare(
    "INSERT INTO rounds (id, kind, opens_at, closes_at, status) VALUES (?1, 'daily', ?2, ?3, 'closed')",
  )
    .bind(PREV, FIXTURE_ROUND.opensAt - 86_400_000, FIXTURE_ROUND.opensAt)
    .run();
  await user(EX, 'excluded1');
  await user(NOPREF, 'nopref1');
  // user: web push; played yesterday; not today; a 4-day stray streak with streak_at_risk on.
  await pushSub(ids.user, 1);
  await seedEntry(env.DB, PREV, 'free', ids.user, 0);
  await streak(ids.user, 'free', 2);
  await streak(ids.user, 'stakes', 4);
  await setPref(env.DB, ids.user, 'webpush', 'streak_at_risk', true);
  // otherUser: a Farcaster token; didn't play yesterday; already entered today.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO identities (id, user_id, provider, external_id, verified_at) VALUES ('01K7I00000000000000000000201', ?1, 'farcaster', '201', 1)",
    ).bind(ids.otherUser),
    env.DB.prepare(
      "INSERT INTO farcaster_notification_tokens (fid, app_fid, url, token, updated_at) VALUES (201, 9152, 'https://api.farcaster.xyz/v1/frame-notifications', 't201', 1)",
    ),
  ]);
  await seedEntry(env.DB, round.roundId, 'free', ids.otherUser, 1);
  // admin: no channel. EX: web push but self-excluded. NOPREF: a streak but the event left off.
  await pushSub(EX, 2);
  await exclude(env.DB, EX, T + 86_400_000);
  await streak(EX, 'free', 9);
  await setPref(env.DB, EX, 'webpush', 'streak_at_risk', true);
  await pushSub(NOPREF, 3);
  await streak(NOPREF, 'free', 5);
});

const users = (ms: NotifyMessage[]) => ms.map((m) => m.userId).sort();

describe('roundNotifications', () => {
  it('question_live: reachable users with no entry in the daily round that just closed', async () => {
    const ms = await roundNotifications(env, 'question_live', round, T);
    expect(users(ms)).toEqual([ids.otherUser, NOPREF].sort());
    expect(ms.find((m) => m.userId === NOPREF)).toEqual({
      event: 'question_live',
      userId: NOPREF,
      dedupeKey: `question_live:${round.roundId}:${NOPREF}`,
      payload: { roundId: round.roundId, gameDay: '2026-10-08' },
    });
  });

  it('closing_soon: reachable users not yet entered', async () => {
    const ms = await roundNotifications(env, 'closing_soon', round, T);
    expect(users(ms)).toEqual([ids.user, NOPREF].sort());
    expect(ms[0]?.payload).toEqual({
      roundId: round.roundId,
      closesAt: FIXTURE_ROUND.closesAt / 1000,
    });
  });

  it('streak_at_risk: not entered, the event on, a stray streak of at least 3 in either mode', async () => {
    const ms = await roundNotifications(env, 'streak_at_risk', round, T);
    expect(ms).toEqual([
      {
        event: 'streak_at_risk',
        userId: ids.user,
        dedupeKey: `streak_at_risk:${round.roundId}:${ids.user}`,
        payload: {
          roundId: round.roundId,
          strayStreak: 4,
          closesAt: FIXTURE_ROUND.closesAt / 1000,
        },
      },
    ]);
  });

  it('room rounds send nothing', async () => {
    for (const event of ['question_live', 'closing_soon', 'streak_at_risk'] as const) {
      expect(
        await roundNotifications(env, event, { ...round, kind: 'room', roomId: ids.room }, T),
      ).toEqual([]);
    }
  });
});

describe('an alarm that fires twice', () => {
  it('enqueues the same keys again, and the consumer sends each notification once', async () => {
    const queued: NotifyMessage[] = [];
    const qenv = {
      ...env,
      FLOCKED_TEST_CLOCK: String(T),
      QUEUE_NOTIFY: {
        sendBatch: (ms: { body: NotifyMessage }[]) =>
          Promise.resolve(void queued.push(...ms.map((m) => m.body))),
      },
    } as unknown as Env;
    expect(await enqueueNotifications(qenv, 'closing_soon', round)).toBe(2);
    expect(await enqueueNotifications(qenv, 'closing_soon', round)).toBe(2);
    const { deps, webpush } = fakeDeps();
    expect(await notifyBatch(queued, env, deps)).toEqual(['ok', 'ok', 'retry', 'retry']);
    expect(webpush.sent.map((d) => d.dedupeKey).sort()).toEqual(
      [
        `closing_soon:${round.roundId}:${ids.user}`,
        `closing_soon:${round.roundId}:${NOPREF}`,
      ].sort(),
    );
    // The repeats were retried (the first copies held their keys); redelivered, they send nothing.
    expect(await notifyBatch(queued, env, deps)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(webpush.sent).toHaveLength(2);
  });
});

describe('postDailyCast', () => {
  const poster = (fail = false) => {
    const posts: Parameters<CastPoster['post']>[0][] = [];
    let failing = fail;
    const p: CastPoster = {
      post: (c) => {
        if (failing) {
          failing = false;
          return Promise.reject(new Error('cast API answered 503'));
        }
        posts.push(c);
        return Promise.resolve();
      },
    };
    return { p, posts };
  };

  it('casts the question with the round as its embed, once per round', async () => {
    const { p, posts } = poster();
    expect(await postDailyCast(env, round, p)).toBe('posted');
    expect(await postDailyCast(env, round, p)).toBe('already');
    expect(posts).toEqual([
      {
        text: 'Pineapple on pizza?',
        embedUrl: `https://flocked.xyz/r/${round.roundId}`,
        idem: `daily_cast:${round.roundId}`,
      },
    ]);
  });

  it('a failed cast is released and posts on the next try; room rounds and no signer cast nothing', async () => {
    const other = { ...round, roundId: PREV };
    await env.DB.prepare('UPDATE rounds SET question_id = ?2 WHERE id = ?1')
      .bind(PREV, ids.question)
      .run();
    const { p, posts } = poster(true);
    expect(await postDailyCast(env, other, p)).toBe('failed');
    expect(await postDailyCast(env, other, p)).toBe('posted');
    expect(posts).toHaveLength(1);
    expect(await postDailyCast(env, { ...round, kind: 'room', roomId: ids.room }, p)).toBe(
      'skipped',
    );
    expect(await postDailyCast(env, round, null)).toBe('skipped');
  });
});
