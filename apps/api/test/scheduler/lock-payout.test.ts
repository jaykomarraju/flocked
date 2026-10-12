// The Stakes `payoutAddress` frozen at lock (O4, Oct 12, 2026; spec "Round lifecycle" › the lock
// row, "Data model" rounds.config_json): the author's payout wallet from Settings when it is the
// resolved creator, else null (house questions, the treasury), whatever a draft says; GET /rounds/:id
// publishes it from the locked config, not from the author's prefs.
import { env } from 'cloudflare:test';
import {
  LOCKED_CONFIG_DEFAULTS,
  LockedConfigSchema,
  RoundDetailResponseSchema,
} from '@flocked/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailySlot, insertDailyRound } from '../../src/scheduler/create.js';
import { lockRound } from '../../src/scheduler/lock.js';
import { drand } from '../anchor-do/helpers.js';
import { insertUser, request } from '../read/helpers.js';
import { HOUR, insertQuestion, roundRow } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

const WALLET = '0x00000000000000000000000000000000a11ce001';
const TREASURY = '0x000000000000000000000000000000000000beef';

let day = 0;

/** A daily round with a Stakes draft whose creator is `creator`, and its question. */
async function draftRound(questionId: string, creator: string, extra: object = {}) {
  const slot = dailySlot(`2027-01-${String(++day).padStart(2, '0')}`);
  const id = (await insertDailyRound(env.DB, slot)) as string;
  const draft = {
    beaconDelay: LOCKED_CONFIG_DEFAULTS.beaconDelay,
    free: { ...LOCKED_CONFIG_DEFAULTS.free, awardRecipient: null },
    stakes: { ...LOCKED_CONFIG_DEFAULTS.stakes, creator, ...extra },
  };
  await env.DB.prepare('UPDATE rounds SET question_id = ?2, config_json = ?3 WHERE id = ?1')
    .bind(id, questionId, JSON.stringify(draft))
    .run();
  return { id, lockAt: slot.opensAt - 6 * HOUR };
}

async function lockedStakes(id: string, lockAt: number) {
  expect(await lockRound(env, drand, await roundRow(id), lockAt)).toMatchObject({
    status: 'locked',
  });
  const row = await roundRow(id);
  return LockedConfigSchema.parse(JSON.parse(row.config_json ?? 'null')).stakes;
}

describe('lockRound freezes the Stakes payoutAddress', () => {
  it('the author’s payout wallet when it is the creator; later prefs changes don’t move it', async () => {
    const author = await insertUser({ prefs: { creator_payout_wallet: WALLET.toUpperCase() } });
    const qId = await insertQuestion({ author, status: 'scheduled' });
    // A category the API's read model knows (the scheduler helper's is a placeholder).
    await env.DB.prepare("UPDATE questions SET category = 'other' WHERE id = ?1").bind(qId).run();
    const r = await draftRound(qId, WALLET);
    expect(await lockedStakes(r.id, r.lockAt)).toMatchObject({
      creator: WALLET,
      payoutAddress: WALLET,
    });
    // The round as published: the frozen wallet, even after the author clears it.
    await env.DB.prepare("UPDATE users SET prefs_json = '{}' WHERE id = ?1").bind(author).run();
    const res = await request(`/rounds/${r.id}`);
    expect(res.status).toBe(200);
    const round = RoundDetailResponseSchema.parse(await res.json()).round;
    expect(round.config?.stakes).toMatchObject({ creator: WALLET, payoutAddress: WALLET });
  });

  it('null when the creator is the treasury, the author has none, or the question is a house one', async () => {
    const author = await insertUser({ prefs: { creator_payout_wallet: WALLET } });
    const noWallet = await insertUser();
    const cases = [
      // The creator is the treasury, not the author's wallet.
      await draftRound(await insertQuestion({ author, status: 'scheduled' }), TREASURY),
      // The author named no wallet; a draft's own payoutAddress is never kept.
      await draftRound(await insertQuestion({ author: noWallet, status: 'scheduled' }), WALLET, {
        payoutAddress: WALLET,
      }),
      // A house question.
      await draftRound(await insertQuestion({ status: 'scheduled' }), WALLET),
    ];
    for (const r of cases) {
      expect((await lockedStakes(r.id, r.lockAt))?.payoutAddress).toBeNull();
    }
  });
});
