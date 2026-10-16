// The Stakes `payoutAddress` frozen at lock (O4, Oct 12, 2026; spec "Round lifecycle" › the lock
// row, "Data model" rounds.config_json). Since W8-A (decision C5) the lock resolves `creator` and
// `payoutAddress` together: the author's payout wallet in both when the author passes every check
// (test/questions/creator.test.ts has each check), else the draft's creator (the treasury) and null,
// whatever a draft says; GET /rounds/:id publishes them from the locked config, not from the
// author's prefs.
import { env } from 'cloudflare:test';
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  RoundDetailResponseSchema,
} from '@flocked/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import { lockRound } from '../../src/scheduler/lock.js';
import { drand } from '../anchor-do/helpers.js';
import { insertUser, request } from '../read/helpers.js';
import {
  HOUR,
  TREASURY,
  creatorHarness,
  insertQuestion,
  passingAuthor,
  roundRow,
  setGeoAllow,
} from './helpers.js';

afterEach(() => vi.restoreAllMocks());
beforeAll(() => setGeoAllow(['US']));

const h = creatorHarness();

let day = 0;

/** A daily round with a Stakes draft whose creator is the treasury, and its question. */
async function draftRound(questionId: string, extra: object = {}) {
  const slot = dailySlot(`2027-01-${String(++day).padStart(2, '0')}`);
  const id = (await insertDailyRound(env.DB, slot)) as string;
  const draft = {
    beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
    free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
    stakes: { ...LOCKED_CONFIG_DEFAULTS.stakes, creator: TREASURY, ...extra },
  };
  await env.DB.prepare('UPDATE rounds SET question_id = ?2, config_json = ?3 WHERE id = ?1')
    .bind(id, questionId, JSON.stringify(draft))
    .run();
  return { id, lockAt: slot.opensAt - 6 * HOUR };
}

async function lockedStakes(id: string, lockAt: number) {
  expect(await lockRound(h.env, drand, await roundRow(id), lockAt)).toMatchObject({
    status: 'locked',
  });
  const row = await roundRow(id);
  return LockedConfigSchema.parse(JSON.parse(row.config_json ?? 'null')).stakes;
}

describe('lockRound freezes the Stakes creator and payoutAddress', () => {
  it('the author’s payout wallet in both; later prefs changes don’t move it', async () => {
    const author = await passingAuthor(h.chain);
    // Settings may hold the wallet in any case; the lock freezes it lowercase.
    await env.DB.prepare('UPDATE users SET prefs_json = ?2 WHERE id = ?1')
      .bind(
        author.id,
        JSON.stringify({
          creator_payout_wallet: author.wallet.toUpperCase(),
          creator_payout_location_ok_at: 1,
        }),
      )
      .run();
    const qId = await insertQuestion({ author: author.id, status: 'scheduled' });
    const r = await draftRound(qId);
    expect(await lockedStakes(r.id, r.lockAt)).toMatchObject({
      creator: author.wallet,
      payoutAddress: author.wallet,
    });
    // The round as published: the frozen wallet, even after the author clears it.
    await env.DB.prepare("UPDATE users SET prefs_json = '{}' WHERE id = ?1").bind(author.id).run();
    const res = await request(`/rounds/${r.id}`);
    expect(res.status).toBe(200);
    const round = RoundDetailResponseSchema.parse(await res.json()).round;
    expect(round.config?.stakes).toMatchObject({
      creator: author.wallet,
      payoutAddress: author.wallet,
    });
  });

  it('the treasury and null for an author who fails a check, whatever the draft says, and for a house question', async () => {
    const noWallet = await insertUser();
    const failing = await draftRound(
      await insertQuestion({ author: noWallet, status: 'scheduled' }),
      // A draft's own payoutAddress is never kept.
      { payoutAddress: '0x00000000000000000000000000000000a11ce001' },
    );
    const house = await draftRound(await insertQuestion({ status: 'scheduled' }));
    for (const r of [failing, house]) {
      expect(await lockedStakes(r.id, r.lockAt)).toMatchObject({
        creator: TREASURY,
        payoutAddress: null,
      });
    }
  });
});
