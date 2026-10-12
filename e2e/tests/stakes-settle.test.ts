// A Stakes round settles end to end on the local stack (W6-A): six players enter a Stakes-only
// round on the escrow with tickets this test signs with the stack's ticket-signer key (the API never
// holds it; the seam records each ticket, as W6-B's signer path will). Only the cron driver and the
// Durable Objects' alarms move the round: lock and `createRound`, open, the indexer's ingestion,
// close, the entry set streamed and reconciled once the safe head passes the close block, the
// beacon, decryption, the bundle and `propose`. The test checks that the amounts the contract derives
// from the posted headcounts are @flocked/settle's, computed here in Node (NFR-4, part), then moves
// anvil and the game clock to claimsOpenAt: the backend calls `finalize`, and the indexer settles the
// mode and writes the payouts.
//
// anvil mines no empty blocks and its `safe` tag trails `latest` by 32 blocks, so the test mines past
// the close block. Its chain clock moves 2 hours forward (the challenge window) and can't come back:
// run this file last on a stack (or `pnpm stack:down && pnpm stack:up` after it).
//
//   pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/stakes-settle.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import { settle, stakesPayoutTree, type EntryInput, type StakesLeafKind } from '@flocked/settle';
import { ticketDigest, ticketTypedData } from '@flocked/shared';
import { chainFromEnv, encodePlaintext, encryptPick, roundRefFromChainId } from '@flocked/tlock';
import {
  bytesToHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_DIR, readDevVars, readState } from '../stack/env.mjs';

interface StackState {
  ready: boolean;
  apiUrl: string;
  drand: { chainHash: string; publicKey: string; genesis: number; period: number };
  anvil: { rpcUrl: string; chainId: number };
  contracts: { escrow: Address; usdc: Address };
}

interface SeamStakes {
  status: string;
  chainRoundId: string | null;
  refundReason: number | null;
  bundleHash: Hex | null;
  claimsOpenAt: number | null;
  finalAt: number | null;
  settlements: { seq: number; outcome: string; bundleHash: Hex; txHash: Hex | null }[];
  payouts: { userId: string; wallet: string; kind: string; amount: number }[];
  entries: {
    userId: string | null;
    wallet: string;
    optionIndex: number | null;
    valid: boolean | null;
  }[];
}

interface SeamRound {
  status: string;
  state: { status: string; beaconRound: number; beaconTimeSec: number };
  stakes: SeamStakes | null;
}

const state = readState() as StackState | null;
const vars = readDevVars() as Record<string, string> | null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seam(path: string, body?: unknown) {
  const res = await fetch(`${state!.apiUrl}/__test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${vars!.FLOCKED_TEST_SEAM_KEY}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await res.json();
  return { status: res.status, body: json };
}

async function poll<T>(what: string, untilMs: number, fn: () => Promise<T | null>): Promise<T> {
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    if (Date.now() > untilMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

const readRound = async (id: string): Promise<SeamRound | null> => {
  const res = await seam(`/rounds/${id}`);
  return res.status === 200 ? (res.body as SeamRound) : null;
};

/** The escrow's ticket-signer key, which `stack:up` writes beside (never into) the API's vars. */
function ticketSignerKey(): Hex {
  const text = readFileSync(join(RUN_DIR, 'ticket-signer.dev.vars'), 'utf8');
  const m = /^TICKET_SIGNER_KEY='?(0x[0-9a-fA-F]{64})'?$/m.exec(text);
  if (!m) throw new Error('no TICKET_SIGNER_KEY in e2e/stack/.run/ticket-signer.dev.vars');
  return m[1] as Hex;
}

const STAKE = 1_000_000n;
/** Two on option 0 (the minority, so it wins), three on option 1, and one VOID. */
const PICKS: (0 | 1 | null)[] = [0, 0, 1, 1, 1, null];
const KIND: Record<string, StakesLeafKind> = { win: 0, rebate: 1, void_refund: 2 };

interface Player {
  account: PrivateKeyAccount;
  option: 0 | 1 | null;
}

describe.skipIf(!state?.ready || !vars)('local stack: a Stakes round proposes and settles', () => {
  const rpc = http(state?.anvil.rpcUrl);
  const client = createPublicClient({ chain: foundry, transport: rpc });
  const testClient = createTestClient({ chain: foundry, mode: 'anvil', transport: rpc });
  const players: Player[] = PICKS.map((option) => ({
    account: privateKeyToAccount(generatePrivateKey()),
    option,
  }));
  let roundId: string;
  let chainRoundId: bigint;
  let closesAt: number;
  let round: SeamRound;

  const escrowRound = () =>
    client.readContract({
      address: state!.contracts.escrow,
      abi: flockedEscrowAbi,
      functionName: 'getRound',
      args: [chainRoundId],
    });

  beforeAll(async () => {
    // Wall time for the Worker and every DO (another test may have pinned the clock).
    await seam('/clock', { nowMs: null });
  });
  afterAll(async () => {
    await seam('/clock', { nowMs: null });
  });

  it('the scheduler locks a Stakes-only round, creates it onchain and opens it', async () => {
    const t0 = Math.ceil(Date.now() / 1000) * 1000;
    const opensAt = t0 + 30_000;
    closesAt = opensAt + 60_000;
    const res = await seam('/rounds/scheduled', {
      opensAt,
      closesAt,
      beaconDelay: 60,
      free: false,
      stakes: { stake: String(STAKE), minEntrants: 3, capMultiple: 1 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    roundId = (res.body as { roundId: string }).roundId;
    round = await poll('the round to open with its escrow round', opensAt + 30_000, async () => {
      const r = await readRound(roundId);
      return r?.status === 'open' && r.stakes?.chainRoundId ? r : null;
    });
    chainRoundId = BigInt(round.stakes!.chainRoundId!);
    expect(round.stakes?.status).toBe('pending');
  });

  it('six players enter on the escrow; the indexer stores each entry with its user', async () => {
    const chain = chainFromEnv({
      DRAND_CHAIN_HASH: state!.drand.chainHash,
      DRAND_PUBLIC_KEY: state!.drand.publicKey,
      DRAND_GENESIS: String(state!.drand.genesis),
      DRAND_PERIOD: String(state!.drand.period),
    });
    const signer = privateKeyToAccount(ticketSignerKey());
    const target = { chainId: foundry.id, verifyingContract: state!.contracts.escrow };
    for (const p of players) {
      const wallet = createWalletClient({ account: p.account, chain: foundry, transport: rpc });
      await testClient.setBalance({ address: p.account.address, value: 10n ** 18n });
      const send = async (hash: Promise<Hex>) => {
        const receipt = await client.waitForTransactionReceipt({ hash: await hash });
        expect(receipt.status).toBe('success');
      };
      await send(
        wallet.writeContract({
          address: state!.contracts.usdc,
          abi: mockUsdcAbi,
          functionName: 'mint',
          args: [p.account.address, STAKE],
        }),
      );
      await send(
        wallet.writeContract({
          address: state!.contracts.usdc,
          abi: mockUsdcAbi,
          functionName: 'approve',
          args: [state!.contracts.escrow, STAKE],
        }),
      );
      const ticket = {
        roundId: chainRoundId,
        wallet: p.account.address,
        personTag: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        expiry: BigInt(closesAt / 1000 + 3600),
      };
      const signature = await signer.signTypedData(ticketTypedData(target, ticket));
      const recorded = await seam('/stakes/tickets', {
        roundId,
        wallet: p.account.address.toLowerCase(),
        personTag: ticket.personTag,
        expiry: Number(ticket.expiry),
        ticketHash: ticketDigest(target, ticket),
      });
      expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
      const pt = encodePlaintext({
        roundRef: roundRefFromChainId(chainRoundId),
        optionIndex: p.option ?? 0,
        nonce: crypto.getRandomValues(new Uint8Array(16)),
      });
      if (p.option === null) pt[17] = 2; // the option byte: a well-formed ciphertext, a bad pick
      const ct = await encryptPick(chain, round.state.beaconRound, pt);
      await send(
        wallet.writeContract({
          address: state!.contracts.escrow,
          abi: flockedEscrowAbi,
          functionName: 'enter',
          args: [chainRoundId, bytesToHex(ct), ticket, signature],
        }),
      );
    }
    expect(Date.now()).toBeLessThan(closesAt);
    round = await poll('the indexer to store the six entries', closesAt, async () => {
      const r = await readRound(roundId);
      const stored = r?.stakes?.entries ?? [];
      return stored.length === PICKS.length && stored.every((e) => e.userId) ? r : null;
    });
  });

  it('proposes after the beacon and the safe head: the contract derives settle’s amounts (NFR-4, part)', async () => {
    // Past close, mine past the close block until anvil's safe head (32 behind) is past it too.
    await poll('close', closesAt + 10_000, () =>
      Promise.resolve(Date.now() >= closesAt + 1_000 ? true : null),
    );
    await testClient.mine({ blocks: 40 });
    const beaconMs = round.state.beaconTimeSec * 1000;
    round = await poll('the proposal, mirrored by the indexer', beaconMs + 180_000, async () => {
      const r = await readRound(roundId);
      return r?.stakes?.status === 'settle_proposed' ? r : null;
    });

    const onchain = await escrowRound();
    expect(onchain.status).toBe(2); // SettleProposed
    expect([onchain.n0, onchain.n1, onchain.nVoid]).toEqual([2, 3, 1]);
    const inputs: EntryInput[] = players.map((p) => ({
      account: p.account.address.toLowerCase(),
      stake: STAKE,
      option: p.option,
      voidReason: p.option === null ? 'bad_option' : null,
    }));
    const { record, payouts } = settle(inputs, {
      feeBps: 500,
      creatorBps: 100,
      capMultiple: 1,
      minEntrants: 3,
    });
    const amount = (kind: string) => payouts.find((p) => p.kind === kind)?.amount ?? 0n;
    expect(record).toMatchObject({ outcome: 'settled', winner: 0 });
    expect({
      winPayout: onchain.winPayout,
      rebatePayout: onchain.rebatePayout,
      fee: onchain.fee,
      creatorFee: onchain.creatorFee,
      dust: onchain.dust,
    }).toEqual({
      winPayout: amount('win'),
      rebatePayout: amount('rebate'),
      fee: record.fee,
      creatorFee: record.creatorFee,
      dust: record.dust,
    });
    expect(amount('rebate')).toBeGreaterThan(0n);
    const tree = stakesPayoutTree(
      chainRoundId,
      payouts.map((p) => ({ account: p.account as Hex, kind: KIND[p.kind] as StakesLeafKind })),
    );
    expect(onchain.payoutRoot).toBe(tree.root);

    // The bundle hash posted is the manifest's, and the manifest names the close block.
    const res = await fetch(`${state!.apiUrl}/__test/bundles/${roundId}/stakes/manifest.json`, {
      headers: { authorization: `Bearer ${vars!.FLOCKED_TEST_SEAM_KEY}` },
    });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(onchain.bundleHash).toBe(keccak256(bytes));
    expect(round.stakes?.bundleHash).toBe(keccak256(bytes));
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      closeBlock: { number: number; hash: Hex } | null;
      chainRoundId: string;
    };
    expect(manifest.chainRoundId).toBe(String(chainRoundId));
    const close = await client.getBlock({ blockNumber: BigInt(manifest.closeBlock!.number) });
    expect(close.hash).toBe(manifest.closeBlock!.hash);
    expect(Number(close.timestamp)).toBeLessThan(closesAt / 1000);
    const next = await client.getBlock({ blockNumber: close.number + 1n });
    expect(Number(next.timestamp)).toBeGreaterThanOrEqual(closesAt / 1000);
    expect(round.stakes?.claimsOpenAt).toBe(Number(onchain.claimsOpenAt) * 1000);
    expect(round.stakes?.payouts).toEqual([]);
  });

  it('finalizes at claimsOpenAt: settled, with every payout in D1', async () => {
    const claimsOpenAt = Number((await escrowRound()).claimsOpenAt);
    // The challenge window (2 h) on anvil's clock and the game clock, which the backend reads.
    await testClient.setNextBlockTimestamp({ timestamp: BigInt(claimsOpenAt) });
    await testClient.mine({ blocks: 1 });
    await seam('/clock', { nowMs: claimsOpenAt * 1000 });
    round = await poll('finalize, mirrored by the indexer', Date.now() + 180_000, async () => {
      const r = await readRound(roundId);
      return r?.stakes?.status === 'settled' ? r : null;
    });
    expect((await escrowRound()).status).toBe(4); // Settled
    expect(round.stakes?.finalAt).toBeGreaterThan(0);

    const inputs: EntryInput[] = players.map((p) => ({
      account: p.account.address.toLowerCase(),
      stake: STAKE,
      option: p.option,
      voidReason: p.option === null ? 'bad_option' : null,
    }));
    const { payouts } = settle(inputs, {
      feeBps: 500,
      creatorBps: 100,
      capMultiple: 1,
      minEntrants: 3,
    });
    const want = payouts
      .map((p) => ({ wallet: p.account, kind: p.kind, amount: Number(p.amount) }))
      .sort((a, b) => a.wallet.localeCompare(b.wallet) || a.kind.localeCompare(b.kind));
    expect(
      round.stakes?.payouts.map(({ wallet, kind, amount }) => ({ wallet, kind, amount })),
    ).toEqual(want);
    expect(round.stakes?.entries.map((e) => e.optionIndex)).toEqual([0, 0, 1, 1, 1, null]);
  });
});
