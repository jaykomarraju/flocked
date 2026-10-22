// W9-Z's review findings in the notify consumer (W9-F1 R2–R4), each with the producer and the
// consumer in one path:
//   * R2: a Stakes refund the contract proposed first is the day's `outcome` at the proposal only
//     when it is the user's first mode outcome, and is told as `refunded` when it becomes final
//     (spec "Notifications", owner decision Oct 16, 2026). Before the fix a provisional rule-1
//     refund went out as `refunded` at the proposal, 2 h before claims open and with a veto still
//     possible, and the real finalization was deduped away — or, when Stakes claimed the day's key
//     first, no `refunded` was ever sent;
//   * R3: each claim is fenced by its lease, so a batch stalled past 60 s can't record a channel,
//     finish the key or release the lease of the delivery that reclaimed it; the clock is read per
//     message; and a channel request that stalls is aborted;
//   * R4: an outcome is rendered from the account that entered and delivered to the account it
//     joined, because a merge never re-points `entries`.
import { env } from 'cloudflare:test';
import type { NotifyMessage } from '@flocked/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { timedFetch } from '../../src/notify/channels/index.js';
import {
  NotifyRetry,
  notifyBatch,
  notifyHandler,
  type NotifyDeps,
} from '../../src/notify/consumer.js';
import { LEASE_MS } from '../../src/notify/dedupe.js';
import { enqueueModeOutcome, notifyOnModeFinal } from '../../src/notify/outcomes.js';
import type { Channel, Delivery } from '../../src/notify/types.js';
import type { Env } from '../../src/env.js';
import { seedFixture, type Fixture } from '../helpers/index.js';
import { T, fakeDeps, outcomeMessage, seedEntry, seedResult, verifyEmail } from './helpers.js';

const ORIGIN = 'https://flocked.xyz';
/** The account a merged member's notifications go to (R4). */
const KEEPER = '01K70000000000000000000051';

let fx: Fixture;
let ids: Fixture['ids'];
let round: string;

/** `env` with a recording notify queue, for the producers in src/notify/outcomes.ts. */
let enqueued: NotifyMessage[] = [];
const queueEnv = () =>
  ({
    ...env,
    QUEUE_NOTIFY: {
      send: (body: NotifyMessage) => Promise.resolve(void enqueued.push(body)),
      sendBatch: (ms: { body: NotifyMessage }[]) =>
        Promise.resolve(void enqueued.push(...ms.map((m) => m.body))),
    },
  }) as unknown as Env;

const logRow = (key: string) =>
  env.DB.prepare(
    'SELECT claimed_until, channels, done_at FROM notification_log WHERE dedupe_key = ?1',
  )
    .bind(key)
    .first<{ claimed_until: number | null; channels: string; done_at: number | null }>();

const edited = (userId: string, auditId: string): NotifyMessage => ({
  event: 'question_edited',
  userId,
  dedupeKey: `question_edited:${auditId}`,
  payload: { questionId: '01K70000000000000000000010', auditId },
});

/** The Stakes mode's state, without touching its settlement record. */
const setStakes = (status: string, refundReason: number | null, claimsOpenAt: number | null) =>
  env.DB.prepare(
    `UPDATE round_modes SET status = ?2, refund_reason = ?3, claims_open_at = ?4,
       final_at = CASE WHEN ?2 IN ('settled', 'refunded', 'voided') THEN ?5 ELSE NULL END
     WHERE round_id = ?1 AND mode = 'stakes'`,
  )
    .bind(round, status, refundReason, claimsOpenAt, T)
    .run();

beforeAll(async () => {
  fx = await seedFixture(env.DB);
  ids = fx.ids;
  round = fx.round.id;
  // Free: option 0 won with 1 of 4 valid entries. The player entered both modes.
  await seedEntry(env.DB, round, 'free', ids.user, 0);
  await seedEntry(env.DB, round, 'stakes', ids.user, 0);
  await seedResult(env.DB, round, 'free', { status: 'settled', winner: 0, tally: [1, 3] });
  // The Stakes refund proposal (rule 1: VOID entries left too few valid ones), with its record.
  await seedResult(env.DB, round, 'stakes', {
    status: 'refund_proposed',
    winner: null,
    refundReason: 1,
    tally: [1, 3],
  });
  await verifyEmail(env.DB, ids.user, 'player@example.com');
});

beforeEach(async () => {
  enqueued = [];
  await env.DB.prepare('DELETE FROM notification_log').run();
});

describe('R2: a proposed Stakes refund', () => {
  /** The proposal's enqueue, as the indexer's `OutcomeProposed` handler runs it. */
  async function proposalMessages(): Promise<NotifyMessage[]> {
    await setStakes('refund_proposed', 1, T + 7_200_000);
    enqueued = [];
    await enqueueModeOutcome(queueEnv(), round, 'stakes');
    return enqueued;
  }

  /** The finalization's enqueue, as the post-final hook runs it on `RoundRefunded`. */
  async function finalMessages(): Promise<NotifyMessage[]> {
    await setStakes('refunded', 1, T + 7_200_000);
    enqueued = [];
    await notifyOnModeFinal(queueEnv(), {
      roundId: round,
      mode: 'stakes',
      kind: 'daily',
      outcome: 'refunded',
    });
    return enqueued;
  }

  it('is the day’s outcome when it is the user’s first, and `refunded` once final', async () => {
    const { deps, webpush } = fakeDeps();
    const proposal = await proposalMessages();
    expect(proposal.map((m) => m.event === 'outcome' && m.payload.provisional)).toEqual([true]);
    for (const m of proposal) await notifyHandler(m, env, deps);
    expect(webpush.sent.map((d) => [d.event, d.copy.title])).toEqual([
      ['outcome', 'Stakes round refunded'],
    ]);

    // The Free reveal comes later the same game day: app-only, as any second mode outcome.
    await notifyHandler(outcomeMessage(ids.user, round, 'free', { amount: '87' }), env, deps);
    expect(webpush.sent).toHaveLength(1);

    // It becomes final: the user hears that the refund is real, under the `refunded` key.
    const final = await finalMessages();
    expect(final.map((m) => m.dedupeKey)).toEqual([`refunded:${round}:stakes:${ids.user}`]);
    for (const m of final) await notifyHandler(m, env, deps);
    expect(webpush.sent.map((d) => [d.event, d.targetUrl])).toEqual([
      ['outcome', `${ORIGIN}/r/${round}`],
      ['refunded', `${ORIGIN}/claims`],
    ]);
  });

  it('stays in the app at the proposal when Free was first, and is `refunded` once final', async () => {
    const { deps, webpush } = fakeDeps();
    await notifyHandler(outcomeMessage(ids.user, round, 'free', { amount: '87' }), env, deps);
    expect(webpush.sent.map((d) => d.event)).toEqual(['outcome']);

    // Nothing goes out at the proposal: claims are 2 h away and a veto can still take it back.
    for (const m of await proposalMessages()) await notifyHandler(m, env, deps);
    expect(webpush.sent).toHaveLength(1);

    for (const m of await finalMessages()) await notifyHandler(m, env, deps);
    expect(webpush.sent.map((d) => d.event)).toEqual(['outcome', 'refunded']);
  });

  it('a Stakes refund with no proposal is still final when it happens', async () => {
    const { deps, webpush } = fakeDeps();
    await notifyHandler(outcomeMessage(ids.user, round, 'free', { amount: '87' }), env, deps);
    // `refundTooFew` from the SettlementDO: refunded with no proposal, so no claims_open_at.
    await setStakes('refunded', 1, null);
    await notifyOnModeFinal(queueEnv(), {
      roundId: round,
      mode: 'stakes',
      kind: 'daily',
      outcome: 'refunded',
    });
    expect(enqueued.map((m) => m.event === 'outcome' && m.payload.provisional)).toEqual([
      undefined,
    ]);
    for (const m of enqueued) await notifyHandler(m, env, deps);
    expect(webpush.sent.map((d) => [d.event, d.dedupeKey])).toEqual([
      ['outcome', `outcome:2026-10-08:${ids.user}`],
      ['refunded', `refunded:${round}:stakes:${ids.user}`],
    ]);
  });
});

describe('R3: the dedupe lease', () => {
  interface Gated<C extends 'webpush'> {
    channel: Channel<C>;
    /** Resolves once `send` has been called (so the key is claimed). */
    entered: Promise<void>;
    /** Lets that `send` finish. */
    open: () => void;
    sent: Delivery<C>[];
  }

  /** A web push channel whose `send` waits until the test lets it finish. */
  function gatedChannel(outcome: 'ok' | 'retry'): Gated<'webpush'> {
    let entered = () => {};
    let open = () => {};
    const enteredPromise = new Promise<void>((r) => (entered = r));
    const opened = new Promise<void>((r) => (open = r));
    const sent: Delivery<'webpush'>[] = [];
    return {
      sent,
      entered: enteredPromise,
      open: () => open(),
      channel: {
        name: 'webpush',
        available: () => true,
        async send(batch) {
          entered();
          await opened;
          if (outcome === 'retry') return { retry: batch.map((d) => d.dedupeKey) };
          sent.push(...batch);
          return { retry: [] };
        },
      },
    };
  }

  const depsFor = (channel: Channel<'webpush'>, now: number): NotifyDeps => ({
    channels: { webpush: channel },
    origin: ORIGIN,
    now: () => now,
  });

  /**
   * The first delivery claims `key`, stalls in `send` past its 60 s lease, and a second delivery
   * takes the expired lease over and is still sending. Returns both, each still gated.
   */
  async function stalledRace(key: string, first: 'ok' | 'retry', second: 'ok' | 'retry') {
    const msg = edited(ids.user, key.slice('question_edited:'.length));
    const stalled = gatedChannel(first);
    const stalledRun = notifyHandler(msg, env, depsFor(stalled.channel, T));
    await stalled.entered;
    expect((await logRow(key))?.claimed_until).toBe(T + LEASE_MS);
    const late = T + LEASE_MS + 1;
    const holder = gatedChannel(second);
    const holderRun = notifyHandler(msg, env, depsFor(holder.channel, late));
    await holder.entered;
    expect((await logRow(key))?.claimed_until).toBe(late + LEASE_MS);
    return { msg, late, stalled, stalledRun, holder, holderRun };
  }

  it('a stalled batch can’t release the lease the second delivery holds', async () => {
    const key = 'question_edited:stall-release';
    const r = await stalledRace(key, 'retry', 'ok');

    // The stalled batch finishes now: its channel failed, but the key is no longer its to release.
    r.stalled.open();
    await r.stalledRun;
    expect(await logRow(key)).toMatchObject({ claimed_until: r.late + LEASE_MS, done_at: null });

    // So a redelivery finds the holder's live lease and waits instead of sending in parallel.
    const third = fakeDeps();
    await expect(
      notifyHandler(r.msg, env, { ...third.deps, now: () => r.late + 1 }),
    ).rejects.toBeInstanceOf(NotifyRetry);
    expect(third.webpush.sent).toEqual([]);

    // The holder records and finishes the key itself.
    r.holder.open();
    await r.holderRun;
    expect(r.holder.sent.map((d) => d.dedupeKey)).toEqual([key]);
    expect(await logRow(key)).toEqual({
      claimed_until: null,
      channels: '["webpush"]',
      done_at: r.late,
    });
  });

  it('a stalled batch can’t record or finish a key the second delivery gave up', async () => {
    const key = 'question_edited:stall-finish';
    const r = await stalledRace(key, 'ok', 'retry');

    // The holder's channel fails: it records nothing and gives its own lease up for the retry.
    r.holder.open();
    await expect(r.holderRun).rejects.toBeInstanceOf(NotifyRetry);
    expect(await logRow(key)).toEqual({ claimed_until: null, channels: '[]', done_at: null });

    // The stalled batch's send succeeded, but the key is no longer its to record or finish.
    r.stalled.open();
    await r.stalledRun;
    expect(r.stalled.sent.map((d) => d.dedupeKey)).toEqual([key]);
    expect(await logRow(key)).toEqual({ claimed_until: null, channels: '[]', done_at: null });

    // So the queue's retry still delivers what the holder didn't.
    const third = fakeDeps();
    await notifyHandler(r.msg, env, { ...third.deps, now: () => r.late + 1 });
    expect(third.webpush.sent.map((d) => d.dedupeKey)).toEqual([key]);
    const row = await logRow(key);
    expect((JSON.parse(row?.channels ?? '[]') as string[]).sort()).toEqual([
      'farcaster',
      'webpush',
    ]);
    expect(row?.done_at).toBe(r.late + 1);
  });

  it('claims each message of a batch at the clock it was handled', async () => {
    const { deps, webpush } = fakeDeps();
    let t = T;
    const results = await notifyBatch(
      [edited(ids.user, 'clock1'), edited(ids.user, 'clock2')],
      env,
      { ...deps, now: () => (t += 1_000) },
    );
    expect(results).toEqual(['ok', 'ok']);
    expect(webpush.sent).toHaveLength(2);
    const { results: rows } = await env.DB.prepare(
      `SELECT created_at FROM notification_log
       WHERE dedupe_key IN ('question_edited:clock1', 'question_edited:clock2')`,
    ).all<{ created_at: number }>();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.created_at)).size).toBe(2);
  });

  it('aborts a channel request that stalls', async () => {
    const aborted: string[] = [];
    const stalling: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('no abort signal'));
        signal.addEventListener('abort', () => {
          aborted.push((signal.reason as Error).name);
          reject(signal.reason as Error);
        });
      });
    await expect(timedFetch(stalling, 20)('https://push.example/send')).rejects.toThrow();
    expect(aborted).toEqual(['TimeoutError']);
  });
});

describe('R4: an outcome for an account that was merged away', () => {
  it('renders from the account that entered and delivers to the account it joined', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, handle, display_name, role, ref_code, created_at, status)
       VALUES (?1, 'keeper', 'keeper', 'user', 'REFKEEP1', 1, 'active')`,
    )
      .bind(KEEPER)
      .run();
    // The player's account is merged into KEEPER after the round: `entries` still name the player.
    await env.DB.prepare("UPDATE users SET status = 'merged', merged_into = ?2 WHERE id = ?1")
      .bind(ids.user, KEEPER)
      .run();
    try {
      const { deps, webpush } = fakeDeps();
      await notifyHandler(outcomeMessage(ids.user, round, 'free', { amount: '87' }), env, deps);
      expect(webpush.sent.map((d) => [d.recipient.userId, d.copy.body])).toEqual([
        [KEEPER, 'You and 25% of people out-thought everyone.'],
      ]);
    } finally {
      await env.DB.prepare("UPDATE users SET status = 'active', merged_into = NULL WHERE id = ?1")
        .bind(ids.user)
        .run();
    }
  });
});
