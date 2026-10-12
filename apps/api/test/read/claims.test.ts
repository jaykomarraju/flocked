// GET /claims (spec "API"; "Identity and personhood" › Merging accounts; W6-D): the unclaimed Stakes
// payouts and refunds of the caller and of every account merged into it (transitively), or of a
// wallet without sign-in from public data only, with claim proofs rebuilt from the bundle and checked
// here against the manifest's payout root. Rounds are settled by the real coordinator against the
// fake escrow chain and indexed by the real handlers; claims are indexed `Claimed` / `RefundClaimed`.
import { env } from 'cloudflare:test';
import {
  ClaimsResponseSchema,
  RoundMeResponseSchema,
  newUlid,
  type ClaimItem,
} from '@flocked/shared';
import type { Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chainEventOf } from '../settlement/stakes-chain.js';
import {
  index,
  seedStakes,
  stakesEnv,
  type Pick,
  type SeededStakes,
} from '../settlement/stakes-helpers.js';
import {
  LEAF_KIND,
  insertRound,
  insertUser,
  lockedConfig,
  request,
  stakesLeaf,
  verifyProof,
} from './helpers.js';
import {
  claimEvent,
  entryTimes,
  finalize,
  propose,
  refundTooFew,
  stakesRecord,
} from './stakes-flow.js';

/** A seeded round whose ticketed entries belong to `owners` (by index; others keep their user). */
async function seed(
  picks: readonly Pick[],
  owners: (string | undefined)[],
  opts: Parameters<typeof seedStakes>[1] = {},
): Promise<SeededStakes> {
  const r = await entryTimes(await seedStakes(picks, opts));
  const stmts = owners.flatMap((owner, i) => {
    const e = r.entries[i];
    if (!owner || !e) return [];
    e.userId = owner;
    return [env.DB.prepare('UPDATE entries SET user_id = ?2 WHERE id = ?1').bind(e.id, owner)];
  });
  if (stmts.length > 0) await env.DB.batch(stmts);
  return r;
}

type Times = Awaited<ReturnType<typeof modeTimes>>;

async function modeTimes(roundId: string) {
  const row = await env.DB.prepare(
    "SELECT status, claims_open_at, final_at FROM round_modes WHERE round_id = ?1 AND mode = 'stakes'",
  )
    .bind(roundId)
    .first<{ status: string; claims_open_at: number | null; final_at: number | null }>();
  if (!row) throw new Error(`no Stakes mode for ${roundId}`);
  return row;
}

async function claims(opts: { userId?: string; wallet?: string }) {
  const res = await request(`/claims${opts.wallet ? `?wallet=${opts.wallet}` : ''}`, {
    ...(opts.userId ? { userId: opts.userId } : {}),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe(
    opts.wallet ? 'public, max-age=5' : 'private, no-store',
  );
  return ClaimsResponseSchema.parse(await res.json()).claims;
}

const byKey = (a: ClaimItem, b: ClaimItem) =>
  `${a.roundId}:${a.account}`.localeCompare(`${b.roundId}:${b.account}`);
const sorted = (items: ClaimItem[]) => [...items].sort(byKey);

/** Every item with a proof proves its leaf against the round's manifest root (= the record's). */
async function expectProofs(items: ClaimItem[]): Promise<number> {
  let checked = 0;
  for (const item of items) {
    if (item.kind === 'refund') {
      expect(item.proof).toBeNull();
      continue;
    }
    const { rec, manifest } = await stakesRecord(item.roundId);
    expect(manifest?.payoutRoot).toBeTruthy();
    expect(manifest?.payoutRoot).toBe(rec?.payout_root);
    expect(manifest?.chainRoundId).toBe(item.chainRoundId);
    const leaf = stakesLeaf(item.chainRoundId, item.account, LEAF_KIND[item.kind]);
    expect(verifyProof(manifest?.payoutRoot as string, leaf, item.proof ?? [])).toBe(true);
    checked += 1;
  }
  return checked;
}

// Accounts: K is signed in; L1 was merged into K and L2 into L1 (a chain); O is someone else.
let K: string;
let L1: string;
let L2: string;
let O: string;
/** A: settled (finalized); B: proposed, no rebate; C: refund proposed; D: refunded; E: voided. */
let A: SeededStakes;
let B: SeededStakes;
let C: SeededStakes;
let D: SeededStakes;
let E: SeededStakes;
let room: { id: string; wallet: Hex; finalAt: number };
let payoutsA: Map<string, bigint>;
let payoutsB: Map<string, bigint>;

const wallet = (r: SeededStakes, i: number) =>
  (r.entries[i] as SeededStakes['entries'][number]).wallet;

beforeAll(async () => {
  stakesEnv();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  K = await insertUser();
  L1 = await insertUser({ mergedInto: K });
  L2 = await insertUser({ mergedInto: L1 });
  O = await insertUser();

  // Option 0 wins; the 1× cap leaves a rebate; entry 3 is a VOID.
  A = await seed([0, 1, 1, 'void'], [L2, K, O, L1], { stakes: { capMultiple: 1 } });
  const hA = await propose(A);
  payoutsA = new Map(hA.applied[0]?.payouts.map((p) => [p.account, p.amount]));
  await finalize(A, hA);
  // The 10× cap isn't reached: the winner takes everything, the losers have nothing to claim.
  B = await seed([0, 1, 1], [K, L1, O]);
  const hB = await propose(B);
  payoutsB = new Map(hB.applied[0]?.payouts.map((p) => [p.account, p.amount]));
  // A headcount tie: a refund proposal (rule 3).
  C = await seed([0, 1, 0, 1], [K, O]);
  await propose(C);
  // Fewer than minEntrants: refundTooFew (rule 1).
  D = await seed([0, 1], [L1, O]);
  await refundTooFew(D);
  // A guardian void (rule 4).
  E = await seed([0, 1, 1], [L2]);
  await index([
    chainEventOf(
      E.chain,
      'RoundRefunded',
      { roundId: E.chainRoundId, reason: 4 },
      { txHash: `0x${'e4'.repeat(32)}`, block: E.chain.head },
    ),
  ]);
  // K's Stakes entry in a room round, from the wallet K used in A.
  const r = await insertRound({
    kind: 'room',
    opensAt: Date.UTC(2026, 9, 1),
    closesAt: Date.UTC(2026, 9, 2),
    config: lockedConfig(['stakes']),
    modes: { stakes: { status: 'refunded', refundReason: 1, chainRoundId: '9000' } },
  });
  room = { id: r.id, wallet: wallet(A, 1), finalAt: r.closesAt + 60_000 };
  await env.DB.prepare(
    `INSERT INTO entries (id, round_id, mode, user_id, wallet, person_tag, stake, commitment, tx_hash,
       block_number, log_index, created_at)
     VALUES (?1, ?2, 'stakes', ?3, ?4, ?5, 5000000, ?6, ?7, 1, 0, ?8)`,
  )
    .bind(
      newUlid(),
      r.id,
      K,
      room.wallet,
      `0x${'9a'.repeat(32)}`,
      `0x${'9b'.repeat(32)}`,
      `0x${'9c'.repeat(32)}`,
      r.opensAt,
    )
    .run();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe('GET /claims, signed in', () => {
  it('lists the caller’s and merged accounts’ unclaimed payouts and refunds, each with its account', async () => {
    const [a, b, c, d, e] = (await Promise.all(
      [A, B, C, D, E].map((r) => modeTimes(r.roundId)),
    )) as [Times, Times, Times, Times, Times];
    expect([a, b, c, d, e].map((m) => m?.status)).toEqual([
      'settled',
      'settle_proposed',
      'refund_proposed',
      'refunded',
      'voided',
    ]);
    const stake = A.stake.toString();
    const payout = (r: SeededStakes, i: number, userId: string, kind: ClaimItem['kind']) => ({
      roundId: r.roundId,
      chainRoundId: r.chainRoundId.toString(),
      kind,
      account: wallet(r, i),
      amount: ((r === A ? payoutsA : payoutsB).get(wallet(r, i)) ?? 0n).toString(),
      proof: expect.any(Array) as unknown,
      claimsOpenAt: (r === A ? a : b).claims_open_at,
      userId,
    });
    const refund = (r: SeededStakes, i: number, userId: string, claimsOpenAt: number | null) => ({
      roundId: r.roundId,
      chainRoundId: r.chainRoundId.toString(),
      kind: 'refund',
      account: wallet(r, i),
      amount: stake,
      proof: null,
      claimsOpenAt,
      userId,
    });
    const items = await claims({ userId: K });
    expect(sorted(items)).toEqual(
      sorted([
        payout(A, 0, L2, 'win'),
        payout(A, 1, K, 'rebate'),
        payout(A, 3, L1, 'void_refund'),
        payout(B, 0, K, 'win'),
        refund(C, 0, K, c.claims_open_at),
        refund(D, 0, L1, d.final_at),
        refund(E, 0, L2, e.final_at),
        {
          roundId: room.id,
          chainRoundId: '9000',
          kind: 'refund',
          account: room.wallet,
          amount: '5000000',
          proof: null,
          claimsOpenAt: room.finalAt,
          userId: K,
        },
      ] as ClaimItem[]),
    );
    // Newest round first.
    expect(items.map((i) => i.roundId)).toEqual([...items.map((i) => i.roundId)].sort().reverse());
    expect(c.claims_open_at).toBeGreaterThan(0);
    expect(await expectProofs(items)).toBe(4);
    // Amounts are settle's: the winner's and the rebate, and the VOID's stake back.
    expect(items.find((i) => i.kind === 'void_refund')?.amount).toBe(stake);
    expect(BigInt(items.find((i) => i.kind === 'rebate')?.amount ?? 0)).toBeGreaterThan(0n);
  });

  it('each merged account sees only its own and what was merged into it', async () => {
    const accounts = async (userId: string) =>
      sorted(await claims({ userId })).map((i) => [i.roundId, i.userId]);
    expect(await accounts(L1)).toEqual(
      sorted((await claims({ userId: K })).filter((i) => i.userId === L1 || i.userId === L2)).map(
        (i) => [i.roundId, i.userId],
      ),
    );
    expect((await claims({ userId: L2 })).every((i) => i.userId === L2)).toBe(true);
    // O lost in B (no rebate) and has its own items elsewhere, none of K's.
    const theirs = await claims({ userId: O });
    expect(theirs.every((i) => i.userId === O)).toBe(true);
    expect(theirs.map((i) => i.roundId)).not.toContain(B.roundId);
    expect(theirs.map((i) => i.roundId)).toContain(A.roundId);
  });

  it('a loser with no rebate has nothing to claim', async () => {
    expect(
      (await claims({ userId: K })).filter((i) => i.userId === L1 && i.roundId === B.roundId),
    ).toEqual([]);
    expect(await claims({ wallet: wallet(B, 1) })).toEqual([]);
    expect(payoutsB.get(wallet(B, 1))).toBeUndefined();
  });

  it('401 without a session or a wallet; 400 for a bad wallet', async () => {
    const res = await request('/claims');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
    for (const bad of ['0x1234', 'not-an-address', `0x${'AB'.repeat(20)}`]) {
      expect((await request(`/claims?wallet=${bad}`)).status).toBe(400);
    }
  });
});

describe('GET /claims?wallet=', () => {
  it('the same payouts from public data, userId null, every proof against the manifest root; room rounds left out', async () => {
    const signedIn = await claims({ userId: K });
    const wallets = [...new Set(signedIn.map((i) => i.account))];
    let fromWallets: ClaimItem[] = [];
    for (const w of wallets) fromWallets = fromWallets.concat(await claims({ wallet: w }));
    const daily = signedIn.filter((i) => i.roundId !== room.id);
    // O's items in A share no wallet with K's accounts.
    expect(sorted(fromWallets)).toEqual(sorted(daily.map((i) => ({ ...i, userId: null }))));
    expect(await expectProofs(fromWallets)).toBe(4);
    // The room-round wallet is also K's wallet in A: only A's rebate comes back.
    expect((await claims({ wallet: room.wallet })).map((i) => [i.roundId, i.kind])).toEqual([
      [A.roundId, 'rebate'],
    ]);
  });

  it('a wallet with no account (a foreign entry) gets its payout and proof', async () => {
    const r = await seed([0, 0, 1, 1, 1], [], { foreign: [0], stakes: { capMultiple: 1 } });
    await propose(r);
    const items = await claims({ wallet: wallet(r, 0) });
    expect(items).toMatchObject([{ roundId: r.roundId, kind: 'win', userId: null }]);
    expect(await expectProofs(items)).toBe(1);
  });

  it('a tampered or missing bundle chunk leaves the item out, never a 500', async () => {
    const r = await seed([0, 1, 1], [], { stakes: { capMultiple: 1 } });
    await propose(r);
    const key = `bundles/${r.roundId}/stakes/chunk-0000.json`;
    const original = new Uint8Array(
      await ((await env.BUCKET.get(key)) as R2ObjectBody).arrayBuffer(),
    );
    const winner = wallet(r, 0);
    // Valid JSON, the same entries, different bytes: the chunk hash no longer matches.
    const tampered = new TextEncoder().encode(`${new TextDecoder().decode(original)} `);
    await env.BUCKET.put(key, tampered);
    expect(await claims({ wallet: winner })).toEqual([]);
    await env.BUCKET.delete(key);
    expect(await claims({ wallet: winner })).toEqual([]);
    // Another round's items are unaffected.
    expect(await claims({ wallet: wallet(A, 0) })).toHaveLength(1);
    await env.BUCKET.put(key, original);
    const restored = await claims({ wallet: winner });
    expect(restored).toMatchObject([{ roundId: r.roundId, kind: 'win' }]);
    expect(await expectProofs(restored)).toBe(1);
  });
});

describe('claims seen onchain', () => {
  it('Claimed takes the payout off the list; a reorg that removes the claim brings it back', async () => {
    const w = wallet(A, 0);
    const claim = claimEvent(A, w, { kind: 0, amount: payoutsA.get(w) ?? 0n });
    await index([claim]);
    expect(await claims({ wallet: w })).toEqual([]);
    expect((await claims({ userId: K })).some((i) => i.account === w)).toBe(false);
    const row = await env.DB.prepare(
      "SELECT claimed_at, claim_tx FROM payouts WHERE round_id = ?1 AND wallet = ?2 AND kind = 'win'",
    )
      .bind(A.roundId, w)
      .first();
    expect(row).toEqual({ claimed_at: claim.blockTimestampSec * 1000, claim_tx: claim.txHash });

    await index([{ ...claim, removed: true, revision: 1 }]);
    expect(await claims({ wallet: w })).toMatchObject([{ roundId: A.roundId, kind: 'win' }]);
    expect((await claims({ userId: K })).some((i) => i.account === w)).toBe(true);
    // The re-mined claim takes it off again.
    await index([{ ...claim, revision: 2 }]);
    expect(await claims({ wallet: w })).toEqual([]);
  });

  it('RefundClaimed takes a refund off the list', async () => {
    const w = wallet(D, 0);
    expect(await claims({ wallet: w })).toMatchObject([{ roundId: D.roundId, kind: 'refund' }]);
    await index([claimEvent(D, w, { refund: D.stake })]);
    expect(await claims({ wallet: w })).toEqual([]);
    expect((await claims({ userId: K })).some((i) => i.roundId === D.roundId)).toBe(false);
  });

  it('a claimed void refund (rule 4) leaves the list too, and /me shows it claimed', async () => {
    const w = wallet(E, 0);
    expect(await claims({ wallet: w })).toMatchObject([{ roundId: E.roundId, kind: 'refund' }]);
    const claim = claimEvent(E, w, { refund: E.stake });
    await index([claim]);
    expect(await claims({ wallet: w })).toEqual([]);
    expect((await claims({ userId: K })).some((i) => i.roundId === E.roundId)).toBe(false);
    const res = await request(`/rounds/${E.roundId}/me`, { userId: L2 });
    expect(RoundMeResponseSchema.parse(await res.json()).modes.stakes).toMatchObject({
      modeStatus: 'voided',
      result: 'refund',
      payouts: [
        {
          kind: 'refund',
          amount: E.stake.toString(),
          wallet: w,
          proof: null,
          claimedAt: claim.blockTimestampSec * 1000,
          claimTx: claim.txHash,
        },
      ],
    });
    // A reorg that removes the claim lists it again.
    await index([{ ...claim, removed: true, revision: 1 }]);
    expect(await claims({ wallet: w })).toMatchObject([{ roundId: E.roundId, kind: 'refund' }]);
  });
});
