// Stakes claim proofs only for a proposal live onchain (W6-F1 R8, R9; src/read/proofs.ts
// liveStakesPayoutIndex): GET /rounds/:id/me and GET /claims serve a payout and its proof only while
// the mode is proposed or settled (a reorg that removes `OutcomeProposed` leaves `revealed_at` set),
// the current record's bundle is the one the chain recorded (`round_modes.bundle_hash`), and the
// rebuilt payout root is the record's as well as the manifest's. Rounds are settled by the real
// coordinator against the fake escrow chain and indexed by the real handlers.
import { env } from 'cloudflare:test';
import { ClaimsResponseSchema, RoundMeResponseSchema, type MyPayout } from '@flocked/shared';
import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventsOf } from '../settlement/stakes-chain.js';
import { index, seedStakes, stakesEnv, type SeededStakes } from '../settlement/stakes-helpers.js';
import { LEAF_KIND, request, stakesLeaf, verifyProof } from './helpers.js';
import { entryTimes, propose, stakesRecord } from './stakes-flow.js';

beforeEach(() => {
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A proposed round (option 0 wins; the 1× cap leaves a rebate) and its winner. */
async function proposed() {
  const r = await entryTimes(await seedStakes([0, 1, 1], { stakes: { capMultiple: 1 } }));
  await propose(r);
  const winner = r.entries[0];
  if (!winner?.userId) throw new Error('no ticketed winner');
  return { r, winner: { userId: winner.userId, wallet: winner.wallet } };
}

async function mePayouts(roundId: string, userId: string): Promise<MyPayout[] | undefined> {
  const res = await request(`/rounds/${roundId}/me`, { userId });
  expect(res.status).toBe(200);
  return RoundMeResponseSchema.parse(await res.json()).modes.stakes?.payouts;
}

async function walletClaims(wallet: string) {
  const res = await request(`/claims?wallet=${wallet}`);
  expect(res.status).toBe(200);
  return ClaimsResponseSchema.parse(await res.json()).claims;
}

async function userClaims(userId: string) {
  const res = await request('/claims', { userId });
  expect(res.status).toBe(200);
  return ClaimsResponseSchema.parse(await res.json()).claims;
}

/** The winner's payout is served by all three reads, with a proof against the proposed root. */
async function expectServed(r: SeededStakes, winner: { userId: string; wallet: Hex }) {
  const { manifest } = await stakesRecord(r.roundId);
  const leaf = stakesLeaf(r.chainRoundId, winner.wallet, LEAF_KIND.win);
  const mine = await mePayouts(r.roundId, winner.userId);
  expect(mine).toMatchObject([{ kind: 'win', wallet: winner.wallet }]);
  expect(verifyProof(manifest?.payoutRoot as string, leaf, mine?.[0]?.proof ?? [])).toBe(true);
  const byWallet = await walletClaims(winner.wallet);
  expect(byWallet).toMatchObject([{ roundId: r.roundId, kind: 'win' }]);
  expect(verifyProof(manifest?.payoutRoot as string, leaf, byWallet[0]?.proof ?? [])).toBe(true);
  expect((await userClaims(winner.userId)).map((i) => [i.roundId, i.kind])).toEqual([
    [r.roundId, 'win'],
  ]);
}

/** None of the three reads serves the winner's payout. */
async function expectWithheld(r: SeededStakes, winner: { userId: string; wallet: Hex }) {
  expect(await mePayouts(r.roundId, winner.userId)).toEqual([]);
  expect(await walletClaims(winner.wallet)).toEqual([]);
  expect(await userClaims(winner.userId)).toEqual([]);
}

async function modeOf(roundId: string) {
  return env.DB.prepare(
    "SELECT status, revealed_at, bundle_hash FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'",
  )
    .bind(roundId)
    .first<{ status: string; revealed_at: number | null; bundle_hash: Hex | null }>();
}

describe('R9: a proposal a reorg removed serves no proof', () => {
  it('back at revealing with revealed_at set: no payout in /me or /claims until it is proposed again', async () => {
    const { r, winner } = await proposed();
    await expectServed(r, winner);
    const proposal = eventsOf(r.chain, r.chain.lastTx('propose')).find(
      (e) => e.event === 'OutcomeProposed',
    );
    if (!proposal) throw new Error('no OutcomeProposed');

    // The reorg: the mode is open again onchain, the record superseded, `revealed_at` kept.
    await index([{ ...proposal, removed: true, revision: 1 }]);
    const reorged = await modeOf(r.roundId);
    expect(reorged).toMatchObject({ status: 'revealing' });
    expect(reorged?.revealed_at).not.toBeNull();
    // The coordinator's record for the next proposal (the same bundle), before that proposal lands.
    await env.DB.prepare(
      "UPDATE settlements SET superseded_at = NULL WHERE round_id = ?1 AND mode = 'stakes'",
    )
      .bind(r.roundId)
      .run();
    await expectWithheld(r, winner);

    // Proposed again onchain: served again.
    await index([{ ...proposal, revision: 2 }]);
    expect((await modeOf(r.roundId))?.status).toBe('settle_proposed');
    await expectServed(r, winner);
  });
});

describe('R8: the proof matches what the chain recorded', () => {
  it('a record whose payout root is not the rebuilt one serves no proof', async () => {
    const { r, winner } = await proposed();
    await expectServed(r, winner);
    const { rec } = await stakesRecord(r.roundId);
    const setRoot = (root: string | null | undefined) =>
      env.DB.prepare(
        "UPDATE settlements SET payout_root = ?2 WHERE round_id = ?1 AND mode = 'stakes' AND superseded_at IS NULL",
      )
        .bind(r.roundId, root ?? null)
        .run();
    await setRoot(`0x${'0f'.repeat(32)}`);
    await expectWithheld(r, winner);
    await setRoot(rec?.payout_root);
    await expectServed(r, winner);
  });

  it('a record for another bundle than the chain recorded serves no proof', async () => {
    const { r, winner } = await proposed();
    await expectServed(r, winner);
    const chainHash = (await modeOf(r.roundId))?.bundle_hash;
    expect(chainHash).toBe((await stakesRecord(r.roundId)).rec?.bundle_hash);
    const setChainHash = (hash: string | null | undefined) =>
      env.DB.prepare(
        "UPDATE round_modes SET bundle_hash = ?2 WHERE round_id = ?1 AND mode = 'stakes'",
      )
        .bind(r.roundId, hash ?? null)
        .run();
    await setChainHash(`0x${'ab'.repeat(32)}`);
    await expectWithheld(r, winner);
    await setChainHash(chainHash);
    await expectServed(r, winner);
  });
});
