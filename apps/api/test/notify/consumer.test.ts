// The notify consumer (src/notify/consumer.ts): dedupe per key, the combined `outcome` at the user's
// first mode outcome, `refunded` only for later events, the exclusion filter, prefs, and the
// `question_rejected` cut. Channels are recording fakes of the Channel interface.
import { env } from 'cloudflare:test';
import { REFUND_LINES, type NotifyMessage } from '@flocked/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotifyRetry, notifyHandler, notifyQueueBatch } from '../../src/notify/consumer.js';
import { seedFixture, type Fixture } from '../helpers/index.js';
import {
  T,
  exclude,
  fakeDeps,
  outcomeMessage,
  seedEntry,
  seedResult,
  setPref,
  verifyEmail,
} from './helpers.js';

let fx: Fixture;
let ids: Fixture['ids'];
let round: string;
const NEXT = '01K70000000000000000000099';

beforeAll(async () => {
  fx = await seedFixture(env.DB);
  ids = fx.ids;
  round = fx.round.id;
  // Free: option 0 won with 1 of 4 valid entries; Stakes: option 1 won.
  await seedEntry(env.DB, round, 'free', ids.user, 0);
  await seedEntry(env.DB, round, 'stakes', ids.user, 0);
  await seedEntry(env.DB, round, 'free', ids.otherUser, 1);
  await seedResult(env.DB, round, 'free', { status: 'settled', winner: 0, tally: [1, 3] });
  await seedResult(env.DB, round, 'stakes', {
    status: 'settle_proposed',
    winner: 1,
    tally: [2, 2],
  });
  await verifyEmail(env.DB, ids.user, 'player@example.com');
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM notification_log').run();
  await env.DB.prepare('DELETE FROM limits').run();
  await env.DB.prepare('DELETE FROM notification_prefs').run();
});

const edited = (userId: string, auditId = 'a1'): NotifyMessage => ({
  event: 'question_edited',
  userId,
  dedupeKey: `question_edited:${auditId}`,
  payload: { questionId: '01K70000000000000000000010', auditId },
});

describe('dedupe', () => {
  it('sends each dedupe key once, however often the message arrives', async () => {
    const { deps, farcaster, webpush } = fakeDeps();
    await notifyHandler(edited(ids.user), env, deps);
    await notifyHandler(edited(ids.user), env, deps);
    expect(farcaster.sent).toHaveLength(1);
    expect(webpush.sent).toHaveLength(1);
    await notifyHandler(edited(ids.user, 'a2'), env, deps);
    expect(webpush.sent.map((d) => d.dedupeKey)).toEqual([
      'question_edited:a1',
      'question_edited:a2',
    ]);
  });

  it('a RoundDO hook that enqueues twice (an eviction) sends closing_soon once', async () => {
    const { deps, webpush } = fakeDeps();
    const msg: NotifyMessage = {
      event: 'closing_soon',
      userId: ids.user,
      dedupeKey: `closing_soon:${round}:${ids.user}`,
      payload: { roundId: round, closesAt: Math.floor(fx.round.closesAt / 1000) },
    };
    await notifyHandler(msg, env, deps);
    await notifyHandler({ ...msg }, env, deps);
    expect(webpush.sent).toHaveLength(1);
    expect(webpush.sent[0]?.copy.title).toBe('An hour left');
  });

  it('a copy that finds another consumer delivering retries later instead of sending', async () => {
    const { deps, webpush } = fakeDeps();
    await env.DB.prepare(
      `INSERT INTO notification_log (dedupe_key, user_id, event, source, claimed_until, created_at)
       VALUES ('question_edited:busy', ?1, 'question_edited', 'question_edited:busy', ?2, ?3)`,
    )
      .bind(ids.user, T + 30_000, T)
      .run();
    await expect(notifyHandler(edited(ids.user, 'busy'), env, deps)).rejects.toBeInstanceOf(
      NotifyRetry,
    );
    expect(webpush.sent).toHaveLength(0);
  });

  it('a transient channel failure retries only the channels not reached', async () => {
    const { deps, farcaster, webpush } = fakeDeps();
    webpush.failOnce.add('question_edited:f1');
    await expect(notifyHandler(edited(ids.user, 'f1'), env, deps)).rejects.toBeInstanceOf(
      NotifyRetry,
    );
    expect(farcaster.sent).toHaveLength(1);
    expect(webpush.sent).toHaveLength(0);
    await notifyHandler(edited(ids.user, 'f1'), env, deps);
    expect(farcaster.sent).toHaveLength(1);
    expect(webpush.sent).toHaveLength(1);
    await notifyHandler(edited(ids.user, 'f1'), env, deps);
    expect(webpush.sent).toHaveLength(1);
  });
});

describe('outcome: one combined message at the first mode outcome', () => {
  it('the first mode outcome carries the result and "the next question is live"; the second mode is app-only', async () => {
    const { deps, farcaster, webpush, email } = fakeDeps();
    await notifyHandler(
      outcomeMessage(ids.user, round, 'free', { amount: '87', nextRoundId: NEXT }),
      env,
      deps,
    );
    expect(farcaster.sent.map((d) => d.copy)).toEqual([
      {
        title: 'Unflocked +87 pts',
        body: 'You and 25% of people out-thought everyone. The next question is live.',
      },
    ]);
    expect(webpush.sent[0]?.targetUrl).toBe(`https://flocked.xyz/r/${round}`);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.copy).toMatchObject({
      subject: 'Unflocked +87 pts',
      cta: 'See the reveal',
    });
    expect(email.sent[0]?.nextLive).toBe(true);

    // The Stakes reveal comes later the same game day: a loss, shown in the app only.
    await notifyHandler(
      outcomeMessage(ids.user, round, 'stakes', { result: 'loss', nextRoundId: NEXT }),
      env,
      deps,
    );
    expect(farcaster.sent).toHaveLength(1);
    expect(webpush.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  it('whichever mode reveals first is the message: a Stakes loss first, then Free is app-only', async () => {
    const { deps, webpush } = fakeDeps();
    await notifyHandler(outcomeMessage(ids.user, round, 'stakes', { result: 'loss' }), env, deps);
    await notifyHandler(outcomeMessage(ids.user, round, 'free', { amount: '87' }), env, deps);
    expect(webpush.sent.map((d) => d.copy)).toEqual([
      { title: 'You got flocked', body: '50% thought the same thing you did.' },
    ]);
  });

  it('a refund that is the first outcome is the outcome, with its refund line', async () => {
    const { deps, webpush } = fakeDeps();
    await notifyHandler(
      outcomeMessage(ids.user, round, 'free', { result: 'refund', refundReason: 1 }),
      env,
      deps,
    );
    expect(webpush.sent).toHaveLength(1);
    expect(webpush.sent[0]?.event).toBe('outcome');
    expect(webpush.sent[0]?.copy).toEqual({ title: 'Free round refunded', body: REFUND_LINES[1] });
  });

  it('a win without an amount uses the no-amount line', async () => {
    const { deps, webpush } = fakeDeps();
    await notifyHandler(outcomeMessage(ids.user, round, 'free'), env, deps);
    expect(webpush.sent[0]?.copy.title).toBe('Unflocked');
  });
});

describe('refunded: only for later events', () => {
  it('a rule-7 Free refund after the Stakes outcome is told as `refunded`', async () => {
    const { deps, webpush, email } = fakeDeps();
    await notifyHandler(outcomeMessage(ids.user, round, 'stakes', { result: 'loss' }), env, deps);
    await notifyHandler(
      outcomeMessage(ids.user, round, 'free', { result: 'refund', refundReason: 7 }),
      env,
      deps,
    );
    expect(webpush.sent.map((d) => [d.event, d.dedupeKey])).toEqual([
      ['outcome', `outcome:2026-10-08:${ids.user}`],
      ['refunded', `refunded:${round}:free:${ids.user}`],
    ]);
    expect(webpush.sent[1]?.copy).toEqual({ title: 'Free round refunded', body: REFUND_LINES[7] });
    expect(email.sent.map((d) => d.event)).toEqual(['outcome', 'refunded']);
    // A redelivery of the same refund sends nothing more.
    await notifyHandler(
      outcomeMessage(ids.user, round, 'free', { result: 'refund', refundReason: 7 }),
      env,
      deps,
    );
    expect(webpush.sent).toHaveLength(2);
  });

  it('a Stakes refundTimeout (rule 6) after the Free outcome is `refunded`, pointing at Claims', async () => {
    const { deps, webpush } = fakeDeps();
    await notifyHandler(outcomeMessage(ids.user, round, 'free', { amount: '87' }), env, deps);
    await notifyHandler(
      outcomeMessage(ids.user, round, 'stakes', { result: 'refund', refundReason: 6 }),
      env,
      deps,
    );
    expect(webpush.sent[1]?.event).toBe('refunded');
    expect(webpush.sent[1]?.copy).toEqual({
      title: 'Stakes round refunded',
      body: `${REFUND_LINES[6]} Your refund is waiting in Claims.`,
    });
    expect(webpush.sent[1]?.targetUrl).toBe('https://flocked.xyz/claims');
  });

  it("a refund at the reveal after the other mode's outcome stays in the app (Free rule 1, a Stakes refund proposal)", async () => {
    const { deps, webpush } = fakeDeps();
    await notifyHandler(outcomeMessage(ids.user, round, 'stakes', { result: 'loss' }), env, deps);
    await notifyHandler(
      outcomeMessage(ids.user, round, 'free', { result: 'refund', refundReason: 1 }),
      env,
      deps,
    );
    expect(webpush.sent).toHaveLength(1);
    await env.DB.prepare('DELETE FROM notification_log').run();
    await notifyHandler(outcomeMessage(ids.user, round, 'free', { amount: '87' }), env, deps);
    await notifyHandler(
      outcomeMessage(ids.user, round, 'stakes', { result: 'refund', refundReason: 2 }),
      env,
      deps,
    );
    expect(webpush.sent).toHaveLength(2);
    expect(webpush.sent[1]?.event).toBe('outcome');
  });
});

describe('exclusion filter', () => {
  const gameMessages = (): NotifyMessage[] => [
    {
      event: 'question_live',
      userId: ids.user,
      dedupeKey: `question_live:${round}:${ids.user}`,
      payload: { roundId: round, gameDay: '2026-10-08' },
    },
    outcomeMessage(ids.user, round, 'free', { amount: '87' }),
    {
      event: 'refunded',
      userId: ids.user,
      dedupeKey: `refunded:${round}:stakes:${ids.user}`,
      payload: { roundId: round, mode: 'stakes', refundReason: 5 },
    },
    {
      event: 'payout_claimable',
      userId: ids.user,
      dedupeKey: `payout_claimable:${round}:stakes:${ids.user}`,
      payload: { roundId: round, mode: 'stakes', amount: '17670000', claimsOpenAt: T },
    },
    {
      event: 'question_used',
      userId: ids.user,
      dedupeKey: `question_used:${ids.question}:scheduled`,
      payload: { questionId: ids.question, stage: 'scheduled', roundId: round },
    },
    edited(ids.user),
    {
      event: 'question_rejected',
      userId: ids.user,
      dedupeKey: `question_rejected:${ids.question}`,
      payload: { questionId: ids.question, reason: 'Duplicate.' },
    },
  ];
  const security: NotifyMessage = {
    event: 'security_notice',
    userId: '01K70000000000000000000001',
    dedupeKey: 'security_notice:n1',
    payload: { noticeId: 'n1', kind: 'identity_unlinked' },
  };

  it('a self-excluded user gets no game notification, and every security notice on every channel', async () => {
    await exclude(env.DB, ids.user, T + 7 * 86_400_000);
    const { deps, farcaster, webpush, email } = fakeDeps();
    for (const m of gameMessages()) await notifyHandler(m, env, deps);
    expect([...farcaster.sent, ...webpush.sent, ...email.sent]).toHaveLength(0);
    await notifyHandler(security, env, deps);
    expect(farcaster.sent.map((d) => d.copy.title)).toEqual(['Sign-in method removed']);
    expect(webpush.sent).toHaveLength(1);
    expect(email.sent.map((d) => d.copy)).toEqual([
      expect.objectContaining({
        subject: 'Sign-in method removed',
        body: "A sign-in method was removed from your Flocked account. If that was you, there's nothing to do. If it wasn't, review your sign-in methods in Settings.",
      }),
    ]);
  });

  it('a permanent exclusion until its lift takes effect; game notifications come back once a timed exclusion ends', async () => {
    await env.DB.prepare(
      `INSERT INTO limits (user_id, self_exclusion_started_at, self_exclusion_permanent, exclusion_lift_requested_at, exclusion_lift_effective_at)
       VALUES (?1, ?2, 1, ?2, ?3)`,
    )
      .bind(ids.user, T - 1000, T + 1000)
      .run();
    const { deps, webpush } = fakeDeps();
    await notifyHandler(edited(ids.user, 'p1'), env, deps);
    expect(webpush.sent).toHaveLength(0);
    await env.DB.prepare('DELETE FROM limits').run();
    await exclude(env.DB, ids.user, T - 1);
    await notifyHandler(edited(ids.user, 'p2'), env, deps);
    expect(webpush.sent).toHaveLength(1);
  });
});

describe('prefs and channels', () => {
  const streak: () => NotifyMessage = () => ({
    event: 'streak_at_risk',
    userId: ids.user,
    dedupeKey: `streak_at_risk:${round}:${ids.user}`,
    payload: { roundId: round, strayStreak: 4, closesAt: Math.floor(fx.round.closesAt / 1000) },
  });

  it('streak_at_risk is off by default and goes only where it was turned on', async () => {
    const { deps, farcaster, webpush } = fakeDeps();
    await notifyHandler(streak(), env, deps);
    expect(webpush.sent).toHaveLength(0);
    await env.DB.prepare('DELETE FROM notification_log').run();
    await setPref(env.DB, ids.user, 'webpush', 'streak_at_risk', true);
    await notifyHandler(streak(), env, deps);
    expect(farcaster.sent).toHaveLength(0);
    expect(webpush.sent.map((d) => d.copy.title)).toEqual(['4-day stray streak']);
  });

  it('a channel turned off is skipped; security notices ignore prefs; email only where verified', async () => {
    await setPref(env.DB, ids.user, 'farcaster', 'outcome', false);
    await setPref(env.DB, ids.user, 'email', 'security_notice', false);
    const { deps, farcaster, webpush, email } = fakeDeps();
    await notifyHandler(outcomeMessage(ids.user, round, 'free', { amount: '87' }), env, deps);
    expect(farcaster.sent).toHaveLength(0);
    expect(webpush.sent).toHaveLength(1);
    await notifyHandler(
      {
        event: 'security_notice',
        userId: ids.user,
        dedupeKey: 'security_notice:n2',
        payload: { noticeId: 'n2', kind: 'email_sign_in' },
      },
      env,
      deps,
    );
    expect(email.sent.map((d) => d.event)).toEqual(['outcome', 'security_notice']);
    await notifyHandler(
      {
        event: 'security_notice',
        userId: ids.otherUser,
        dedupeKey: 'security_notice:n3',
        payload: { noticeId: 'n3', kind: 'merge_completed' },
      },
      env,
      deps,
    );
    expect(email.sent).toHaveLength(2);
    expect(webpush.sent.map((d) => d.dedupeKey)).toContain('security_notice:n3');
  });

  it('payout_claimable goes on web push and email, never Farcaster', async () => {
    const { deps, farcaster, webpush, email } = fakeDeps();
    await notifyHandler(
      {
        event: 'payout_claimable',
        userId: ids.user,
        dedupeKey: `payout_claimable:${round}:stakes:${ids.user}`,
        payload: { roundId: round, mode: 'stakes', amount: '17679999', claimsOpenAt: T },
      },
      env,
      deps,
    );
    expect(farcaster.sent).toHaveLength(0);
    expect(webpush.sent[0]?.copy).toEqual({
      title: 'Ready to claim',
      body: '17.67 USDC is ready to claim. It goes to the wallet that entered.',
    });
    expect(email.sent[0]?.copy.cta).toBe('Claim 17.67 USDC');
  });

  it('question_live carries the question; a merged account is notified as the account it joined; a deleted one is not', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, handle, display_name, role, ref_code, created_at, status, merged_into)
         VALUES ('01K70000000000000000000041', 'gone1', 'gone1', 'user', 'REFGONE1', 1, 'merged', ?1)`,
      ).bind(ids.user),
      env.DB.prepare(
        `INSERT INTO users (id, handle, display_name, role, ref_code, created_at, status)
         VALUES ('01K70000000000000000000042', 'gone2', 'gone2', 'user', 'REFGONE2', 1, 'deleted')`,
      ),
    ]);
    const { deps, webpush } = fakeDeps();
    const live = (userId: string): NotifyMessage => ({
      event: 'question_live',
      userId,
      dedupeKey: `question_live:${round}:${userId}`,
      payload: { roundId: round, gameDay: '2026-10-08' },
    });
    await notifyHandler(live('01K70000000000000000000041'), env, deps);
    await notifyHandler(live('01K70000000000000000000042'), env, deps);
    expect(webpush.sent.map((d) => [d.recipient.userId, d.copy.body])).toEqual([
      [ids.user, 'Pineapple on pizza?'],
    ]);
  });
});

describe('question_rejected', () => {
  it('push only: the title, and the reason cut to 128 characters ending in "…"', async () => {
    const { deps, farcaster, webpush, email } = fakeDeps();
    const reason = `${'This question needs a clearer second option. '.repeat(6)}Thanks.`;
    await notifyHandler(
      {
        event: 'question_rejected',
        userId: ids.user,
        dedupeKey: 'question_rejected:q-long',
        payload: { questionId: ids.question, reason },
      },
      env,
      deps,
    );
    const copy = webpush.sent[0]?.copy;
    expect(copy?.title).toBe('Your question was rejected');
    expect(Array.from(copy?.body ?? '')).toHaveLength(128);
    expect(copy?.body).toBe(`${reason.slice(0, 127)}…`);
    expect(farcaster.sent[0]?.copy).toEqual(copy);
    expect(email.sent).toHaveLength(0);
  });

  it('a reason within the limit is the whole body', async () => {
    const { deps, webpush } = fakeDeps();
    await notifyHandler(
      {
        event: 'question_rejected',
        userId: ids.user,
        dedupeKey: 'question_rejected:q-short',
        payload: { questionId: ids.question, reason: 'Already asked last week.' },
      },
      env,
      deps,
    );
    expect(webpush.sent[0]?.copy.body).toBe('Already asked last week.');
  });
});

describe('notifyQueueBatch', () => {
  it('acks delivered and malformed messages, and retries one a channel failed', async () => {
    const { deps, webpush } = fakeDeps();
    webpush.failOnce.add('question_edited:qb2');
    const calls: string[] = [];
    const message = (id: string, body: unknown) =>
      ({
        id,
        body,
        attempts: 1,
        timestamp: new Date(T),
        ack: () => void calls.push(`ack ${id}`),
        retry: () => void calls.push(`retry ${id}`),
      }) as unknown as Message<unknown>;
    const batch = {
      queue: 'notify',
      messages: [
        message('m1', edited(ids.user, 'qb1')),
        message('m2', edited(ids.user, 'qb2')),
        message('m3', { event: 'nope' }),
      ],
    } as unknown as MessageBatch<unknown>;
    await notifyQueueBatch(batch, env, deps);
    expect(calls.sort()).toEqual(['ack m1', 'ack m3', 'retry m2']);
    expect(webpush.sent.map((d) => d.dedupeKey)).toEqual(['question_edited:qb1']);
  });
});
