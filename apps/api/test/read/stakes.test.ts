// Stakes reads (spec "API"; W6-D): GET /rounds/:id for a proposal and its finalize, and GET
// /rounds/:id/me for a Stakes entry: the wallet and chain coordinates, the payout and its claim proof
// from the bundle (checked against the proposed payout root with FlockedEscrow's leaf encoding),
// claimsOpenAt, a refund, the claim the indexer saw, and the caller's share cards. Rounds are settled
// by the real coordinator against the fake escrow chain and indexed by the real handlers.
import { env } from 'cloudflare:test';
import {
  RoundDetailResponseSchema,
  RoundMeResponseSchema,
  type MyModeEntry,
  type RoundView,
} from '@flocked/shared';
import { keccak256 } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { index, seedStakes, stakesEnv, type SeededStakes } from '../settlement/stakes-helpers.js';
import { LEAF_KIND, insertUser, questionFor, request, stakesLeaf, verifyProof } from './helpers.js';
import {
  claimEvent,
  entryTimes,
  finalize,
  propose,
  refundTooFew,
  stakesRecord,
} from './stakes-flow.js';

beforeEach(() => {
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function getRound(id: string): Promise<RoundView> {
  const res = await request(`/rounds/${id}`);
  expect(res.status).toBe(200);
  const body = await res.json<{ round: RoundView }>();
  // seedStakes locks its rounds at the placeholder time 1 (and a locked round can't change).
  expect(body.round.lockedAt).toBe(1);
  return RoundDetailResponseSchema.parse({ round: { ...body.round, lockedAt: LOCKED_AT } }).round;
}

const LOCKED_AT = Date.UTC(2026, 9, 6);

async function me(roundId: string, userId: string): Promise<MyModeEntry | undefined> {
  const res = await request(`/rounds/${roundId}/me`, { userId });
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  return RoundMeResponseSchema.parse(await res.json()).modes.stakes;
}

async function seed(...args: Parameters<typeof seedStakes>): Promise<SeededStakes> {
  return entryTimes(await seedStakes(...args));
}

function entryAt(r: SeededStakes, i: number) {
  const e = r.entries[i];
  if (!e?.userId) throw new Error(`no ticketed entry ${i}`);
  return { ...e, userId: e.userId };
}

describe('GET /rounds/:id (Stakes)', () => {
  it('a proposal has no settledAt until it is finalized; txHash is the proposal', async () => {
    const author = await insertUser();
    const r = await seed([0, 1, 1], { stakes: { capMultiple: 1 } });
    await questionFor(r.roundId, author);
    const h = await propose(r);
    const onchain = r.chain.round(r.chainRoundId);
    const proposeTx = r.chain.lastTx('propose');
    const { rec, manifest } = await stakesRecord(r.roundId);

    let round = await getRound(r.roundId);
    expect(round.modes.stakes).toMatchObject({
      status: 'settle_proposed',
      entrantCount: 3,
      pool: (3n * r.stake).toString(),
      chainRoundId: r.chainRoundId.toString(),
      claimsOpenAt: onchain.claimsOpenAt * 1000,
      finalAt: null,
      refundReason: null,
      settlement: {
        proposalSeq: 0,
        outcome: 'settled',
        winningOption: 0,
        tally: [
          { headcount: 1, total: r.stake.toString() },
          { headcount: 2, total: (2n * r.stake).toString() },
        ],
        fee: onchain.amounts.fee.toString(),
        creatorFee: onchain.amounts.creatorFee.toString(),
        dust: onchain.amounts.dust.toString(),
        payoutRoot: onchain.payoutRoot,
        bundleHash: onchain.bundleHash,
        txHash: proposeTx,
        settledAt: null,
      },
    });
    expect(round.modes.stakes?.revealedAt).toBeGreaterThan(0);
    expect(manifest?.payoutRoot).toBe(rec?.payout_root);
    expect(round.config?.stakes?.chainRoundId).toBe(r.chainRoundId.toString());

    await finalize(r, h);
    round = await getRound(r.roundId);
    const finalizedAt = r.chain.timeOf(r.chain.head) * 1000;
    expect(round.modes.stakes).toMatchObject({
      status: 'settled',
      finalAt: finalizedAt,
      settlement: { txHash: proposeTx, settledAt: finalizedAt },
    });
  });
});

describe('GET /rounds/:id/me (Stakes)', () => {
  it('the entry, its payout and claim proof against the proposed root, claimsOpenAt, and the claim', async () => {
    // Option 0 wins; the 1× cap leaves a rebate for the losers; entry 3 is a VOID.
    const r = await seed([0, 1, 1, 'void'], { stakes: { capMultiple: 1 } });
    const [winner, loser, , voided] = [0, 1, 2, 3].map((i) => entryAt(r, i)) as [
      ReturnType<typeof entryAt>,
      ReturnType<typeof entryAt>,
      ReturnType<typeof entryAt>,
      ReturnType<typeof entryAt>,
    ];

    // Before the reveal: the entry's chain coordinates, nothing per option.
    const before = await me(r.roundId, winner.userId);
    expect(before).toEqual({
      modeStatus: 'pending',
      entry: {
        id: winner.id,
        stake: r.stake.toString(),
        commitment: keccak256(winner.ct),
        createdAt: r.chain.timeOf(winner.block) * 1000,
        wallet: winner.wallet,
        txHash: winner.txHash,
        blockNumber: winner.block,
        logIndex: 0,
        optionIndex: null,
        valid: null,
        voidReason: null,
      },
      receipt: null,
      inclusionProof: null,
      result: null,
      payouts: [],
      claimsOpenAt: null,
    });

    const h = await propose(r);
    const result = h.applied[0];
    if (!result) throw new Error('not applied');
    const { rec } = await stakesRecord(r.roundId);
    const onchain = r.chain.round(r.chainRoundId);
    expect(rec?.payout_root).toBe(onchain.payoutRoot);
    const settleAmount = (wallet: string) =>
      result.payouts.find((p) => p.account === wallet)?.amount.toString();

    const expectPayout = async (
      e: ReturnType<typeof entryAt>,
      want: { result: string; kind: 'win' | 'rebate' | 'void_refund'; option: 0 | 1 | null },
    ) => {
      const m = await me(r.roundId, e.userId);
      expect(m).toMatchObject({
        modeStatus: 'settle_proposed',
        entry: {
          optionIndex: want.option,
          valid: want.option !== null,
          voidReason: want.option === null ? 'bad_option' : null,
        },
        result: want.result,
        claimsOpenAt: onchain.claimsOpenAt * 1000,
        payouts: [
          {
            kind: want.kind,
            amount: settleAmount(e.wallet),
            wallet: e.wallet,
            claimedAt: null,
            claimTx: null,
          },
        ],
      });
      const p = m?.payouts[0];
      if (!p?.proof) throw new Error('no proof');
      const leaf = stakesLeaf(r.chainRoundId, e.wallet, LEAF_KIND[want.kind]);
      expect(verifyProof(rec?.payout_root as string, leaf, p.proof)).toBe(true);
      // The proof is for this leaf only: not another kind's.
      const other = stakesLeaf(r.chainRoundId, e.wallet, want.kind === 'win' ? 1 : 0);
      expect(verifyProof(rec?.payout_root as string, other, p.proof)).toBe(false);
      return m;
    };
    await expectPayout(winner, { result: 'win', kind: 'win', option: 0 });
    await expectPayout(loser, { result: 'loss', kind: 'rebate', option: 1 });
    await expectPayout(voided, { result: 'void', kind: 'void_refund', option: null });
    expect(settleAmount(winner.wallet)).toBe(onchain.amounts.winPayout.toString());
    expect(settleAmount(loser.wallet)).toBe(onchain.amounts.rebatePayout.toString());

    // Finalized: the same payout (now with its payouts row), until the indexer sees the claim.
    await finalize(r, h);
    const settled = await me(r.roundId, winner.userId);
    expect(settled).toMatchObject({ modeStatus: 'settled', result: 'win' });
    const claim = claimEvent(r, winner.wallet, { kind: 0, amount: onchain.amounts.winPayout });
    await index([claim]);
    const claimed = await me(r.roundId, winner.userId);
    expect(claimed?.payouts).toEqual([
      {
        ...settled?.payouts[0],
        claimedAt: claim.blockTimestampSec * 1000,
        claimTx: claim.txHash,
      },
    ]);
    // A reorg removes the claim: unclaimed again.
    await index([{ ...claim, removed: true, revision: 1 }]);
    expect((await me(r.roundId, winner.userId))?.payouts[0]).toMatchObject({
      claimedAt: null,
      claimTx: null,
    });
    // The loser's rebate is untouched by the winner's claim.
    expect((await me(r.roundId, loser.userId))?.payouts[0]?.claimedAt).toBeNull();
  });

  it('a refunded mode (refundTooFew) shows the refund with no proof, claimed with claimRefund', async () => {
    const r = await seed([0, 1]);
    const e = entryAt(r, 0);
    await refundTooFew(r);
    const refunded = await me(r.roundId, e.userId);
    expect(refunded).toMatchObject({
      modeStatus: 'refunded',
      entry: { optionIndex: null, valid: null },
      result: 'refund',
      payouts: [
        {
          kind: 'refund',
          amount: r.stake.toString(),
          wallet: e.wallet,
          proof: null,
          claimedAt: null,
          claimTx: null,
        },
      ],
    });
    const claim = claimEvent(r, e.wallet, { refund: r.stake });
    await index([claim]);
    expect((await me(r.roundId, e.userId))?.payouts).toEqual([
      {
        kind: 'refund',
        amount: r.stake.toString(),
        wallet: e.wallet,
        proof: null,
        claimedAt: claim.blockTimestampSec * 1000,
        claimTx: claim.txHash,
      },
    ]);
  });

  it('lists the caller’s share cards for the round, oldest first, and no one else’s', async () => {
    const r = await seed([0, 1]);
    const e = entryAt(r, 0);
    const other = entryAt(r, 1);
    const card = (shareId: string, userId: string, mode: string, kind: string, at: number) =>
      env.DB.prepare(
        `INSERT INTO share_cards (share_id, round_id, mode, user_id, kind, r2_prefix, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(shareId, r.roundId, mode, userId, kind, `cards/${shareId}/`, at);
    await env.DB.batch([
      card('shareResultStakes0001', e.userId, 'stakes', 'result', 20),
      card('shareTeaserStakes0001', e.userId, 'stakes', 'teaser', 10),
      card('shareOtherUsers000001', other.userId, 'stakes', 'teaser', 5),
    ]);
    const res = await request(`/rounds/${r.roundId}/me`, { userId: e.userId });
    const body = RoundMeResponseSchema.parse(await res.json());
    expect(body.cards).toEqual([
      { kind: 'teaser', mode: 'stakes', shareId: 'shareTeaserStakes0001' },
      { kind: 'result', mode: 'stakes', shareId: 'shareResultStakes0001' },
    ]);
  });
});
