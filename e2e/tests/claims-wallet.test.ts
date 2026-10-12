// Claims by wallet on the local stack (W6-D; spec "API" GET /claims; PIPE-1): the claim proofs
// `GET /claims?wallet=` serves, with no session, verify against the root the escrow holds.
//
// Builds on stakes-settle's round, which must have run on this stack just before (CI runs this step
// right after it; anvil's clock is then 2 h ahead, past the round's `claimsOpenAt`). The round is the
// escrow's latest `RoundFinalized` as Settled, and its players are its `Entered` logs. For each
// player, the listed item is the payout `@flocked/settle` computes from the round's entries (and none
// when it computes none), its amount is what the escrow pays for that kind, and its proof verifies
// against `getRound(id).payoutRoot`, here in Node (OpenZeppelin's sorted-pair Merkle proof) and in the
// escrow (`claim` simulated from the player). Then one winner claims for real (anvil impersonates
// the wallet): USDC moves, `Claimed` is emitted, and once the indexer mirrors it the wallet's
// `/claims` no longer lists the round.
//
//   pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/stakes-settle.test.ts \
//     && pnpm --filter @flocked/e2e exec vitest run tests/claims-wallet.test.ts
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import { settle, type EntryInput, type VoidReason } from '@flocked/settle';
import { ClaimsResponseSchema, type ClaimItem } from '@flocked/shared';
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { beforeAll, describe, expect, it } from 'vitest';
import { readDevVars, readState } from '../stack/env.mjs';

interface StackState {
  ready: boolean;
  apiUrl: string;
  anvil: { rpcUrl: string; chainId: number };
  contracts: { escrow: Address; usdc: Address };
}

interface SeamStakes {
  status: string;
  chainRoundId: string | null;
  entries: {
    wallet: string;
    optionIndex: number | null;
    valid: boolean | null;
    voidReason: string | null;
  }[];
  payouts: { wallet: string; kind: string; amount: number }[];
}

const state = readState() as StackState | null;
const vars = readDevVars() as Record<string, string> | null;
if (!state?.ready || !vars) throw new Error('the local stack is not up: run `pnpm stack:up` first');

const rpc = http(state.anvil.rpcUrl);
const client = createPublicClient({ chain: foundry, transport: rpc, pollingInterval: 200 });
const testClient = createTestClient({ chain: foundry, mode: 'anvil', transport: rpc });
const { escrow, usdc } = state.contracts;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FlockedEscrow `Kind`. */
const KIND = { win: 0, rebate: 1, void_refund: 2 } as const;
type LeafKind = keyof typeof KIND;
const SETTLED = 4; // FlockedEscrow Status.Settled

/** The escrow's leaf: keccak256(bytes.concat(keccak256(abi.encode(roundId, account, uint8(kind))))). */
function leafOf(roundId: bigint, account: Address, kind: number): Hex {
  return keccak256(
    keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'uint8' }],
        [roundId, account, kind],
      ),
    ),
  );
}

/** OpenZeppelin `MerkleProof.verify`: hash sorted pairs from the leaf up to the root. */
function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let node = leaf.toLowerCase() as Hex;
  for (const sibling of proof.map((p) => p.toLowerCase() as Hex)) {
    node = keccak256(node < sibling ? concat([node, sibling]) : concat([sibling, node]));
  }
  return node === root.toLowerCase();
}

const getRound = (id: bigint) =>
  client.readContract({
    address: escrow,
    abi: flockedEscrowAbi,
    functionName: 'getRound',
    args: [id],
  });

/** `GET /api/v1/claims?wallet=` with no session, validated. */
async function claimsOf(wallet: Address): Promise<ClaimItem[]> {
  const res = await fetch(`${state!.apiUrl}/api/v1/claims?wallet=${wallet.toLowerCase()}`);
  const body: unknown = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return ClaimsResponseSchema.parse(body).claims;
}

async function seamStakes(roundId: string): Promise<SeamStakes> {
  const res = await fetch(`${state!.apiUrl}/__test/rounds/${roundId}`, {
    headers: { authorization: `Bearer ${vars!.FLOCKED_TEST_SEAM_KEY}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { stakes: SeamStakes | null };
  expect(body.stakes).not.toBeNull();
  return body.stakes!;
}

async function poll<T>(what: string, timeoutMs: number, fn: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

describe('claims by wallet: GET /claims?wallet= proofs verify against the escrow’s root', () => {
  let chainRoundId: bigint;
  let round: Awaited<ReturnType<typeof getRound>>;
  let players: Address[];
  let roundId: string;
  /** What @flocked/settle pays each player (lowercase wallet), from the round's entries. */
  const expected = new Map<string, { kind: LeafKind; amount: bigint }>();
  /** Each player's listed item for the round. */
  const listed = new Map<string, ClaimItem>();

  const escrowAmount = (kind: LeafKind) =>
    kind === 'win' ? round.winPayout : kind === 'rebate' ? round.rebatePayout : round.cfg.stake;

  beforeAll(async () => {
    const finalized = await client.getContractEvents({
      address: escrow,
      abi: flockedEscrowAbi,
      eventName: 'RoundFinalized',
      fromBlock: 0n,
      toBlock: 'latest',
    });
    const settled = finalized.filter((l) => l.args.status === SETTLED).at(-1);
    if (!settled?.args.roundId) {
      throw new Error(
        'no Settled Stakes round on the escrow: run tests/stakes-settle.test.ts first',
      );
    }
    chainRoundId = settled.args.roundId;
    round = await getRound(chainRoundId);
    expect(round.status).toBe(SETTLED);
    const entered = await client.getContractEvents({
      address: escrow,
      abi: flockedEscrowAbi,
      eventName: 'Entered',
      args: { roundId: chainRoundId },
      fromBlock: 0n,
      toBlock: 'latest',
    });
    players = entered.map((l) => l.args.player!);
    expect(players.length).toBe(round.entryCount);
  });

  it('lists each player’s payout, with the escrow’s amount and a proof of the onchain root', async () => {
    for (const player of players) {
      const items = (await claimsOf(player)).filter((c) => c.chainRoundId === String(chainRoundId));
      expect(items.length, player).toBeLessThanOrEqual(1);
      if (items[0]) listed.set(player.toLowerCase(), items[0]);
    }
    const first = [...listed.values()][0];
    expect(first, 'no player has a claim').toBeDefined();
    roundId = first!.roundId;

    // What the round pays, from its entries as D1 holds them (W6-A), by @flocked/settle.
    const stakes = await seamStakes(roundId);
    expect(stakes).toMatchObject({ status: 'settled', chainRoundId: String(chainRoundId) });
    expect(stakes.entries.map((e) => e.wallet.toLowerCase()).sort()).toEqual(
      players.map((p) => p.toLowerCase()).sort(),
    );
    const inputs: EntryInput[] = stakes.entries.map((e) => ({
      account: e.wallet.toLowerCase(),
      stake: round.cfg.stake,
      option: e.valid ? (e.optionIndex as 0 | 1) : null,
      voidReason: e.valid ? null : ((e.voidReason ?? 'bad_option') as VoidReason),
    }));
    const { record, payouts } = settle(inputs, {
      feeBps: round.cfg.feeBps,
      creatorBps: round.cfg.creatorBps,
      capMultiple: round.cfg.capMultiple,
      minEntrants: round.cfg.minEntrants,
    });
    expect(record).toMatchObject({ outcome: 'settled', winner: round.winner });
    for (const p of payouts) {
      expect(p.kind).not.toBe('refund');
      const kind = p.kind as LeafKind;
      // The escrow pays one amount per kind; settle's split must be it.
      expect(p.amount, `${kind} for ${p.account}`).toBe(escrowAmount(kind));
      expect(expected.has(p.account), `two payouts for ${p.account}`).toBe(false);
      expected.set(p.account, { kind, amount: p.amount });
    }
    // The indexer's payouts rows agree (written at finalize).
    expect(
      stakes.payouts.map((p) => `${p.wallet.toLowerCase()}:${p.kind}:${p.amount}`).sort(),
    ).toEqual(payouts.map((p) => `${p.account}:${p.kind}:${p.amount}`).sort());

    for (const player of players) {
      const wallet = player.toLowerCase();
      const want = expected.get(wallet);
      const item = listed.get(wallet);
      if (!want) {
        // Nothing to claim (a loser when the rebate is 0): no item.
        expect(item, `${wallet} has nothing to claim`).toBeUndefined();
        continue;
      }
      expect(item, `${wallet} has a ${want.kind}`).toMatchObject({
        roundId,
        chainRoundId: String(chainRoundId),
        kind: want.kind,
        account: wallet,
        amount: String(want.amount),
        userId: null,
        claimsOpenAt: Number(round.claimsOpenAt) * 1000,
      });
      const proof = item!.proof as Hex[];
      expect(proof).not.toBeNull();
      expect(
        verifyProof(proof, round.payoutRoot, leafOf(chainRoundId, player, KIND[want.kind])),
      ).toBe(true);
      // And in the escrow itself: `claim` from the player would pay.
      await client.simulateContract({
        account: player,
        address: escrow,
        abi: flockedEscrowAbi,
        functionName: 'claim',
        args: [chainRoundId, KIND[want.kind], proof],
      });
    }

    // A wallet that never entered has nothing.
    expect(await claimsOf(privateKeyToAccount(generatePrivateKey()).address)).toEqual([]);
  });

  it('a winner claims on anvil; once the indexer sees `Claimed`, /claims drops the round', async () => {
    const winner = players.find((p) => expected.get(p.toLowerCase())?.kind === 'win');
    expect(winner, 'no winner').toBeDefined();
    const item = listed.get(winner!.toLowerCase())!;
    const others = players.filter((p) => p !== winner && listed.has(p.toLowerCase()));

    // The players' keys stayed in stakes-settle: anvil sends as the wallet.
    await testClient.impersonateAccount({ address: winner! });
    await testClient.setBalance({ address: winner!, value: 10n ** 18n });
    const wallet = createWalletClient({ account: winner!, chain: foundry, transport: rpc });
    const balance = () =>
      client.readContract({
        address: usdc,
        abi: mockUsdcAbi,
        functionName: 'balanceOf',
        args: [winner!],
      });
    const before = await balance();
    let receipt;
    try {
      const hash = await wallet.writeContract({
        address: escrow,
        abi: flockedEscrowAbi,
        functionName: 'claim',
        args: [chainRoundId, KIND.win, item.proof as Hex[]],
      });
      receipt = await client.waitForTransactionReceipt({ hash });
    } finally {
      await testClient.stopImpersonatingAccount({ address: winner! });
    }
    expect(receipt.status).toBe('success');
    const [claimed] = parseEventLogs({
      abi: flockedEscrowAbi,
      eventName: 'Claimed',
      logs: receipt.logs,
    });
    expect(claimed?.args).toEqual({
      roundId: chainRoundId,
      player: winner,
      kind: KIND.win,
      amount: round.winPayout,
    });
    const [transfer] = parseEventLogs({
      abi: mockUsdcAbi,
      eventName: 'Transfer',
      logs: receipt.logs,
    });
    expect(transfer?.args).toMatchObject({ from: escrow, to: winner, value: round.winPayout });
    expect((await balance()) - before).toBe(round.winPayout);
    expect(
      await client.readContract({
        address: escrow,
        abi: flockedEscrowAbi,
        functionName: 'hasClaimed',
        args: [chainRoundId, winner!],
      }),
    ).toBe(true);

    // The cron driver kicks the indexer every 5 s; it reads up to anvil's latest block.
    await poll('the indexer to mark the payout claimed', 60_000, async () => {
      const items = await claimsOf(winner!);
      return items.some((c) => c.chainRoundId === String(chainRoundId)) ? null : true;
    });
    // Only that wallet's payout: the others are still listed.
    for (const p of others) {
      const items = await claimsOf(p);
      expect(items.filter((c) => c.chainRoundId === String(chainRoundId))).toEqual([
        listed.get(p.toLowerCase()),
      ]);
    }
  });
});
