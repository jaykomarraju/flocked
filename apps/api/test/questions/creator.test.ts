// The author at question lock (W8-A). The Stakes creator (decision C5; spec "Settlement and payout
// math": C goes to the creator address frozen at question lock): the author's payout wallet in both
// `creator` and `payoutAddress` when every check passes, else the draft's creator (the treasury) and
// null, with the failed check in the audit log; house questions, room rounds and Free-only rounds
// are untouched. And `question_used` (stage `scheduled`; spec "Notifications") to the author of a
// daily round's question.
import { env } from 'cloudflare:test';
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  NotifyMessageSchema,
  addGameDays,
  newUlid,
} from '@flocked/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { TREASURY_CREATOR, resolveCreator } from '../../src/questions/creator.js';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import {
  escrowConfigOf,
  lockRound,
  type QuestionRow,
  type RoundRow,
} from '../../src/scheduler/lock.js';
import { drand } from '../anchor-do/helpers.js';
import {
  HOUR,
  MIN,
  TREASURY,
  creatorHarness,
  insertQuestion,
  passingAuthor,
  roundRow,
  setGeoAllow,
  type TestAuthor,
} from '../scheduler/helpers.js';

const h = creatorHarness();

// A region rule: the verified country is allowed when any rule names it.
beforeAll(() => setGeoAllow(['US-NJ']));
afterEach(() => {
  h.chain.fail = false;
  vi.restoreAllMocks();
});

const STAKES_DRAFT = {
  beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
  free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
  stakes: { ...LOCKED_CONFIG_DEFAULTS.stakes, creator: TREASURY },
};

let day = 0;

/**
 * A round for `questionId` (daily unless `room`), with the Stakes draft unless `freeOnly`. A room
 * round is in the custom room `room-c5`, whose owner's question it takes (W8-D).
 */
async function newRound(questionId: string, o: { room?: boolean; freeOnly?: boolean } = {}) {
  const slot = dailySlot(addGameDays('2027-03-01', ++day));
  const config = o.freeOnly ? null : JSON.stringify(STAKES_DRAFT);
  let id: string;
  if (o.room) {
    id = newUlid();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rooms (id, name, owner_user_id, invite_code, question_source, created_at) VALUES ('room-c5', 'C5', ?1, 'invite-c5', 'custom', 0) ON CONFLICT DO NOTHING",
      ).bind(newUlid()),
      env.DB.prepare("UPDATE questions SET room_id = 'room-c5' WHERE id = ?1").bind(questionId),
      env.DB.prepare(
        "INSERT INTO rounds (id, kind, room_id, question_id, opens_at, closes_at, config_json) VALUES (?1, 'room', 'room-c5', ?2, ?3, ?4, ?5)",
      ).bind(id, questionId, slot.opensAt, slot.closesAt, config),
    ]);
  } else {
    id = (await insertDailyRound(env.DB, slot)) as string;
    await env.DB.prepare('UPDATE rounds SET question_id = ?2, config_json = ?3 WHERE id = ?1')
      .bind(id, questionId, config)
      .run();
  }
  return { id, lockAt: slot.opensAt - 6 * HOUR };
}

async function lockedRow(id: string, lockAt: number, e: Env = h.env): Promise<RoundRow> {
  expect(await lockRound(e, drand, await roundRow(id), lockAt)).toMatchObject({
    status: 'locked',
  });
  return roundRow(id);
}

const configOf = (row: RoundRow) => LockedConfigSchema.parse(JSON.parse(row.config_json ?? 'null'));

async function questionRow(id: string): Promise<QuestionRow> {
  return (await env.DB.prepare('SELECT * FROM questions WHERE id = ?1')
    .bind(id)
    .first()) as unknown as QuestionRow;
}

async function creatorAudit(roundId: string) {
  const { results } = await env.DB.prepare(
    "SELECT data_json FROM audit_log WHERE action = 'stakes_creator' AND target = ?1",
  )
    .bind(roundId)
    .all<{ data_json: string }>();
  return results.map((r) => JSON.parse(r.data_json) as Record<string, unknown>);
}

const run = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();

describe('the Stakes creator at lock', () => {
  it('an author who passes every check: creator = payoutAddress = the payout wallet, and createRound uses it', async () => {
    const a = await passingAuthor(h.chain);
    const qId = await insertQuestion({ author: a.id, status: 'scheduled' });
    const r = await newRound(qId);
    const row = await lockedRow(r.id, r.lockAt);
    expect(configOf(row).stakes).toMatchObject({ creator: a.wallet, payoutAddress: a.wallet });
    expect(escrowConfigOf(row, await questionRow(qId)).creator).toBe(a.wallet);
    expect(await creatorAudit(r.id)).toEqual([
      { questionId: qId, authorUserId: a.id, creator: 'author', failed: null },
    ]);
    expect(await resolveCreator(h.env, { author_user_id: a.id }, r.lockAt)).toEqual({
      creator: a.wallet,
      payoutAddress: a.wallet,
      failed: null,
    });
  });

  /** One failing check each, applied to an otherwise passing author before the lock at `lockAt`. */
  const FAILING: [string, string, (a: TestAuthor, lockAt: number) => Promise<unknown>, string?][] =
    [
      [
        'unverified',
        'author_not_verified',
        (a) => run('UPDATE users SET kyc_status = NULL WHERE id = ?1', a.id),
      ],
      [
        'suspended',
        'author_not_active',
        (a) => run("UPDATE users SET status = 'suspended' WHERE id = ?1", a.id),
      ],
      [
        'deleted',
        'author_not_active',
        (a) => run("UPDATE users SET status = 'deleted' WHERE id = ?1", a.id),
      ],
      [
        'self-excluded',
        'author_self_excluded',
        (a) =>
          run(
            'INSERT INTO limits (user_id, self_exclusion_started_at, self_exclusion_until) VALUES (?1, 0, ?2)',
            a.id,
            Date.UTC(2030, 0, 1),
          ),
      ],
      [
        'permanently self-excluded',
        'author_self_excluded',
        (a) =>
          run(
            'INSERT INTO limits (user_id, self_exclusion_started_at, self_exclusion_permanent) VALUES (?1, 0, 1)',
            a.id,
          ),
      ],
      [
        'no payout wallet',
        'no_payout_wallet',
        (a) =>
          run(
            'UPDATE users SET prefs_json = ?2 WHERE id = ?1',
            a.id,
            JSON.stringify({ creator_payout_location_ok_at: 1 }),
          ),
      ],
      [
        'no request-location pass',
        'location_unchecked',
        (a) =>
          run(
            'UPDATE users SET prefs_json = ?2 WHERE id = ?1',
            a.id,
            JSON.stringify({ creator_payout_wallet: a.wallet }),
          ),
      ],
      [
        'wallet not linked',
        'wallet_not_linked',
        (a) => run('DELETE FROM identities WHERE user_id = ?1', a.id),
      ],
      [
        'wallet linked but unverified',
        'wallet_not_linked',
        (a) => run('UPDATE identities SET verified_at = NULL WHERE user_id = ?1', a.id),
      ],
      [
        'Verified Account attestation revoked',
        'attestation_missing',
        (a) => Promise.resolve(h.chain.revoke(a.accountUid)),
      ],
      [
        'Verified Country attestation revoked',
        'attestation_missing',
        (a) => Promise.resolve(h.chain.revoke(a.countryUid)),
      ],
      [
        'revoked a minute after a read that the attestation cache still holds',
        'attestation_missing',
        async (a, lockAt) => {
          expect(
            (await resolveCreator(h.env, { author_user_id: a.id }, lockAt - 2 * MIN)).creator,
          ).toBe(a.wallet);
          h.chain.revoke(a.accountUid);
        },
      ],
      [
        'the attestation RPC is down',
        'attestation_lookup_failed',
        () => Promise.resolve((h.chain.fail = true)),
      ],
      [
        'attested country ≠ Coinbase country',
        'country_mismatch',
        (a) => run("UPDATE users SET coinbase_country = 'GB' WHERE id = ?1", a.id),
      ],
      ['country not on geo.stakes.allow', 'country_not_allowed', () => Promise.resolve(), 'CA'],
    ];

  it.each(FAILING)(
    '%s: the treasury creator and payoutAddress null',
    async (_, failed, apply, country) => {
      const a = await passingAuthor(h.chain, country);
      const qId = await insertQuestion({ author: a.id, status: 'scheduled' });
      const r = await newRound(qId);
      await apply(a, r.lockAt);
      const row = await lockedRow(r.id, r.lockAt);
      expect(configOf(row).stakes).toMatchObject({ creator: TREASURY, payoutAddress: null });
      expect(escrowConfigOf(row, await questionRow(qId)).creator).toBe(TREASURY);
      expect(await creatorAudit(r.id)).toEqual([
        { questionId: qId, authorUserId: a.id, creator: 'treasury', failed },
      ]);
      // The Free award still goes to the author.
      expect(configOf(row).free?.awardRecipient).toBe(a.id);
    },
  );

  it('a house question: the treasury, with no checks', async () => {
    const qId = await insertQuestion({ status: 'scheduled' });
    const r = await newRound(qId);
    const row = await lockedRow(r.id, r.lockAt);
    expect(configOf(row).stakes).toMatchObject({ creator: TREASURY, payoutAddress: null });
    expect(await creatorAudit(r.id)).toEqual([]);
    expect(await resolveCreator(h.env, { author_user_id: null }, r.lockAt)).toEqual(
      TREASURY_CREATOR,
    );
  });

  it('a room round keeps the draft’s creator, even for an author who passes', async () => {
    // A room round keeps its draft's Stakes mode only with Stakes rooms and Stakes on (W8-D).
    const flags = ['rooms.stakes.enabled', 'mode.stakes.enabled'];
    for (const key of flags) {
      await run(
        "INSERT INTO config (key, value_json, updated_at) VALUES (?1, 'true', 0) ON CONFLICT (key) DO UPDATE SET value_json = 'true'",
        key,
      );
    }
    try {
      const a = await passingAuthor(h.chain);
      const r = await newRound(await insertQuestion({ author: a.id, status: 'scheduled' }), {
        room: true,
      });
      const row = await lockedRow(r.id, r.lockAt);
      expect(configOf(row).stakes).toMatchObject({ creator: TREASURY, payoutAddress: null });
      expect(await creatorAudit(r.id)).toEqual([]);
    } finally {
      for (const key of flags) await run('DELETE FROM config WHERE key = ?1', key);
    }
  });

  it('a Free-only round is unaffected: no Stakes section, no attestation reads', async () => {
    const a = await passingAuthor(h.chain);
    const reads = vi.spyOn(h.chain.client, 'request');
    const r = await newRound(await insertQuestion({ author: a.id, status: 'scheduled' }), {
      freeOnly: true,
    });
    const config = configOf(await lockedRow(r.id, r.lockAt));
    expect(config.stakes).toBeUndefined();
    expect(config.free?.awardRecipient).toBe(a.id);
    expect(reads).not.toHaveBeenCalled();
    expect(await creatorAudit(r.id)).toEqual([]);
  });
});

describe('question_used at lock', () => {
  it('goes to the author of a daily round’s question, once, with the scheduled dedupe key', async () => {
    const author = newUlid();
    const qId = await insertQuestion({ author, status: 'scheduled' });
    const r = await newRound(qId, { freeOnly: true });
    const before = h.notify.messages.length;
    await lockedRow(r.id, r.lockAt);
    const sent = h.notify.messages.slice(before);
    expect(sent).toEqual([
      {
        event: 'question_used',
        userId: author,
        dedupeKey: `question_used:${qId}:scheduled`,
        payload: { questionId: qId, stage: 'scheduled', roundId: r.id },
      },
    ]);
    expect(NotifyMessageSchema.parse(sent[0])).toEqual(sent[0]);
    // A repeated lock sends nothing more.
    expect(await lockRound(h.env, drand, await roundRow(r.id), r.lockAt + 60_000)).toEqual({
      status: 'already_locked',
    });
    expect(h.notify.messages.length).toBe(before + 1);
  });

  it('is not sent for a house question or a room round', async () => {
    const before = h.notify.messages.length;
    const house = await newRound(await insertQuestion({ status: 'scheduled' }), { freeOnly: true });
    await lockedRow(house.id, house.lockAt);
    const room = await newRound(await insertQuestion({ author: newUlid(), status: 'scheduled' }), {
      room: true,
      freeOnly: true,
    });
    await lockedRow(room.id, room.lockAt);
    expect(h.notify.messages.length).toBe(before);
  });

  it('a failed send is logged and never fails the lock', async () => {
    const failing = {
      ...h.env,
      QUEUE_NOTIFY: { send: () => Promise.reject(new Error('queue down')) },
    } as unknown as Env;
    const r = await newRound(await insertQuestion({ author: newUlid(), status: 'scheduled' }), {
      freeOnly: true,
    });
    const row = await lockedRow(r.id, r.lockAt, failing);
    expect(row.locked_at).toBe(r.lockAt);
  });
});
