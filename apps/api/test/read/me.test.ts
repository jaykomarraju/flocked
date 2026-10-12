// GET /rounds/:id/me for Free (spec "API"; W6-D): the caller's entry, the receipt it got at commit
// (re-signed from D1 by the receipt key), its inclusion proof in the commitment root the RoundDO
// wrote at close, and after the real settlement the result and payouts; refunds (rule 2 at
// settlement, rule 4 void, rule 7) as one `refund` payout of the stake. Stakes /me is in
// stakes.test.ts; reveal gating is test/gating's.
import { env } from 'cloudflare:test';
import { FREE_COMMITMENT_LEAF, freeCommitmentTree } from '@flocked/settle';
import {
  CreateEntryResponseSchema,
  MODE_CODES,
  RoundMeResponseSchema,
  ulidToBytes,
  type CreateEntryResponse,
  type LockedConfig,
  type MyModeEntry,
} from '@flocked/shared';
import { toBase64Url } from '@flocked/tlock';
import { bytesToHex, type Hex } from 'viem';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverReceiptSigner } from '../../src/crypto/receipt.js';
import type { LockedRound } from '../../src/do/types.js';
import { applyVoid } from '../../src/lifecycle/void.js';
import { refundFree } from '../../src/settlement/apply/free.js';
import { alarmAt, useTestSigner } from '../round-do/helpers.js';
import {
  BEACON,
  BEACON_TIME_MS,
  atBeaconPlus,
  harness,
  mirrorCommitted,
  pick,
  recordedDeps,
  seedPicks,
  tamperedPick,
  type SeededRound,
} from '../settlement/helpers.js';
import {
  insertRound,
  insertUser,
  leafHash,
  postEntry,
  request,
  setClock,
  verifyProof,
} from './helpers.js';

const HOUR = 3_600_000;
let signer: Hex;

beforeAll(() => {
  signer = useTestSigner();
});
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function me(roundId: string, userId: string) {
  const res = await request(`/rounds/${roundId}/me`, { userId });
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  return RoundMeResponseSchema.parse(await res.json());
}

async function freeMe(roundId: string, userId: string): Promise<MyModeEntry> {
  const free = (await me(roundId, userId)).modes.free;
  if (!free) throw new Error(`no Free entry for ${userId}`);
  return free;
}

/** The receipt's commitment leaf (bytes16 roundId, uint8 mode, userIdHash, stake, commitment, seq). */
function receiptLeaf(r: CreateEntryResponse['receipt']): Hex {
  return leafHash(FREE_COMMITMENT_LEAF, [
    bytesToHex(ulidToBytes(r.roundId)),
    MODE_CODES.free,
    r.userIdHash,
    BigInt(r.stake),
    r.commitment,
    r.seq,
  ]);
}

async function freeMode(roundId: string) {
  return env.DB.prepare(
    "SELECT status, commitment_root, final_at FROM round_modes WHERE round_id = ?1 AND mode = 'free'",
  )
    .bind(roundId)
    .first<{ status: string; commitment_root: Hex | null; final_at: number | null }>();
}

describe('GET /rounds/:id/me (Free)', () => {
  it('the entry, its commit receipt, the inclusion proof in the anchored root, then the result and payouts', async () => {
    // A daily round entered through the RoundDO, sealed to the recorded beacon so it can settle.
    const closesAt = BEACON_TIME_MS - 120_000 - 600_000;
    const round = await insertRound({
      opensAt: closesAt - 24 * HOUR,
      closesAt,
      beaconRound: BEACON.round,
      status: 'open',
      modes: { free: {} },
    });
    const locked: LockedRound = {
      roundId: round.id,
      kind: 'daily',
      roomId: null,
      questionId: round.questionId,
      opensAt: round.opensAt,
      closesAt,
      beaconRound: BEACON.round,
      beaconTimeSec: BEACON_TIME_MS / 1000,
      config: round.config,
      modes: ['free'],
    };
    const stub = env.ROUND.get(env.ROUND.idFromName(round.id));
    setClock(closesAt - HOUR);
    await stub.init(locked);

    const plays: { option: 0 | 1 | 'void'; stake: string }[] = [
      { option: 0, stake: '10' },
      { option: 1, stake: '25' },
      { option: 1, stake: '40' },
      { option: 'void', stake: '10' },
    ];
    const players: { userId: string; commit: CreateEntryResponse }[] = [];
    for (const p of plays) {
      const userId = await insertUser();
      const ct =
        p.option === 'void' ? await tamperedPick(round.id, 17, 2) : await pick(round.id, p.option);
      const res = await postEntry(userId, round.id, p.stake, toBase64Url(ct));
      expect(res.status).toBe(201);
      players.push({ userId, commit: CreateEntryResponseSchema.parse(await res.json()) });
    }
    const [winner, loser, , voided] = players as [
      (typeof players)[number],
      (typeof players)[number],
      (typeof players)[number],
      (typeof players)[number],
    ];

    // Open: the entry and its receipt, no proof (no root yet), nothing per option.
    expect(await freeMe(round.id, winner.userId)).toEqual({
      modeStatus: 'pending',
      entry: {
        id: winner.commit.entry.id,
        stake: '10',
        commitment: winner.commit.entry.commitment,
        createdAt: winner.commit.entry.createdAt,
        wallet: null,
        txHash: null,
        blockNumber: null,
        logIndex: null,
        optionIndex: null,
        valid: null,
        voidReason: null,
      },
      receipt: winner.commit.receipt,
      inclusionProof: null,
      result: null,
      payouts: [],
      claimsOpenAt: null,
    });

    // Close: the RoundDO writes the commitment root, the tree of the receipts the players hold.
    await alarmAt(stub, closesAt + 1_000);
    const root = (await freeMode(round.id))?.commitment_root;
    const tree = freeCommitmentTree(
      players.map(({ commit: { receipt: r } }) => ({
        roundId: ulidToBytes(r.roundId),
        mode: MODE_CODES.free,
        userIdHash: r.userIdHash as Hex,
        stake: BigInt(r.stake),
        commitment: r.commitment as Hex,
        seq: r.seq,
      })),
    );
    expect(root).toBe(tree.root);
    for (const p of players) {
      const m = await freeMe(round.id, p.userId);
      // The receipt it got at commit, signed by the receipt key.
      expect(m.receipt).toEqual(p.commit.receipt);
      expect(m.receipt?.signer).toBe(signer);
      expect(await recoverReceiptSigner(m.receipt as CreateEntryResponse['receipt'])).toBe(signer);
      expect(m.inclusionProof).not.toBeNull();
      expect(verifyProof(root as Hex, receiptLeaf(p.commit.receipt), m.inclusionProof ?? [])).toBe(
        true,
      );
      // Not a proof of another player's leaf.
      const other = players.find((x) => x !== p) as (typeof players)[number];
      expect(
        verifyProof(root as Hex, receiptLeaf(other.commit.receipt), m.inclusionProof ?? []),
      ).toBe(false);
    }

    // The commitment anchored and mirrored, then the real settlement at the beacon.
    const commitTx: Hex = `0x${'c0'.repeat(32)}`;
    await env.DB.prepare(
      "UPDATE round_modes SET commit_tx = ?2 WHERE round_id = ?1 AND mode = 'free'",
    )
      .bind(round.id, commitTx)
      .run();
    await mirrorCommitted(
      {
        roundId: round.id,
        commitTx,
        root: root as Hex,
        entries: plays.map((p) => ({ stake: Number(p.stake) })),
      } as unknown as SeededRound,
      plays.length,
    );
    atBeaconPlus(5_000);
    const h = await harness(round.id, { apply: 'real' });
    expect(await h.run()).toMatchObject({ phase: 'done', error: null });
    const result = h.applied[0];
    if (!result) throw new Error('not applied');
    const settledAt = BEACON_TIME_MS + 5_000;
    const amountOf = (p: (typeof players)[number]) =>
      result.payouts.find((x) => x.account === p.commit.receipt.userIdHash);

    const won = await freeMe(round.id, winner.userId);
    expect(won).toMatchObject({
      modeStatus: 'settled',
      entry: { optionIndex: 0, valid: true, voidReason: null },
      receipt: winner.commit.receipt,
      result: 'win',
      payouts: [
        {
          kind: 'win',
          amount: amountOf(winner)?.amount.toString(),
          wallet: null,
          proof: null,
          claimedAt: settledAt,
          claimTx: null,
        },
      ],
      claimsOpenAt: null,
    });
    expect(
      verifyProof(root as Hex, receiptLeaf(winner.commit.receipt), won.inclusionProof ?? []),
    ).toBe(true);
    // The 10× cap isn't reached: the winner takes the whole loss pool and the losers get no rebate.
    expect(amountOf(winner)?.amount).toBe(75n);
    expect(amountOf(loser)).toBeUndefined();
    expect(await freeMe(round.id, loser.userId)).toMatchObject({
      entry: { optionIndex: 1, valid: true },
      result: 'loss',
      payouts: [],
    });
    expect(await freeMe(round.id, voided.userId)).toMatchObject({
      entry: { optionIndex: null, valid: false, voidReason: 'bad_option' },
      result: 'void',
      payouts: [
        { kind: 'void_refund', amount: '10', wallet: null, proof: null, claimedAt: settledAt },
      ],
    });

    // Someone with no entry in the round sees nothing.
    expect(await me(round.id, await insertUser())).toEqual({
      roundId: round.id,
      modes: {},
      cards: [],
    });
  });

  it('a mode refunded at settlement (rule 2): the result is a refund, the payout the stake', async () => {
    atBeaconPlus(5_000);
    const r = await seedPicks([1, 1, 1]);
    const h = await harness(r.roundId, { apply: 'real' });
    expect(await h.run()).toMatchObject({ phase: 'done' });
    const e = r.entries[0] as SeededRound['entries'][number];
    expect(await freeMe(r.roundId, e.userId)).toMatchObject({
      modeStatus: 'refunded',
      entry: { optionIndex: 1, valid: true },
      result: 'refund',
      payouts: [
        {
          kind: 'refund',
          amount: '10',
          wallet: null,
          proof: null,
          claimedAt: BEACON_TIME_MS + 5_000,
          claimTx: null,
        },
      ],
    });
  });

  it('rule 4 (void): one refund payout of the stake, like rules 7 and 8', async () => {
    const t = BEACON_TIME_MS - 3_600_000;
    const voidedRound = await seedPicks([0, 1, 1]);
    const lockedOf = (roundId: string, config: LockedConfig) =>
      ({ roundId, kind: 'daily', roomId: null, modes: ['free'], config }) as unknown as LockedRound;
    await applyVoid(env, lockedOf(voidedRound.roundId, voidedRound.config), t);
    const notAnchored = await seedPicks([0, 1], { anchored: 0, mirror: false });
    setClock(BEACON_TIME_MS + 1_000);
    await refundFree(env, notAnchored.roundId, 7, recordedDeps().deps);
    const refundedAt = (await freeMode(notAnchored.roundId))?.final_at;

    const rule4 = await freeMe(
      voidedRound.roundId,
      (voidedRound.entries[1] as SeededRound['entries'][number]).userId,
    );
    const rule7 = await freeMe(
      notAnchored.roundId,
      (notAnchored.entries[1] as SeededRound['entries'][number]).userId,
    );
    expect(rule4).toMatchObject({
      modeStatus: 'voided',
      entry: { optionIndex: null, valid: null, voidReason: null },
      result: 'refund',
      payouts: [
        { kind: 'refund', amount: '10', wallet: null, proof: null, claimedAt: t, claimTx: null },
      ],
    });
    expect(rule7).toMatchObject({
      modeStatus: 'refunded',
      result: 'refund',
      payouts: [
        {
          kind: 'refund',
          amount: '10',
          wallet: null,
          proof: null,
          claimedAt: refundedAt,
          claimTx: null,
        },
      ],
    });
    // One shape for every Free refund.
    expect(rule4.payouts.map(({ claimedAt: _, ...p }) => p)).toEqual(
      rule7.payouts.map(({ claimedAt: _, ...p }) => p),
    );
    // Each voided entry gets exactly one refund payout, whatever its option.
    for (const e of voidedRound.entries) {
      expect((await freeMe(voidedRound.roundId, e.userId)).payouts).toHaveLength(1);
    }
  });
});
