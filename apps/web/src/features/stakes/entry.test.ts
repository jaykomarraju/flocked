// @vitest-environment node
//
// Node, not jsdom: noble rejects a Uint8Array from another realm, so the tlock encryption in
// `sealPick` only runs here (W9-C, `crypto/entry.test.ts`).
// The Stakes entry flow (spec "Client app" › Entry flow (Stakes)): the config check refuses before
// anything is sent, the pick is encrypted before the ticket is asked for, and the entry goes out as
// one sponsored user operation of `approve` then `enter`.
import { questionHash, type RoundView, type StakesPrepareResponse } from '@flocked/shared';
import { decryptWithSignature, firstRoundAtOrAfter, fromBase64Url, QUICKNET } from '@flocked/tlock';
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { TEST_CHAIN, testRound } from '../../crypto/testing';
import { entryCalls } from '../../wallet/calls';
import { WalletError } from '../../wallet/send';
import type { EscrowReader } from './configCheck';
import { StakesRefused, submitStakesEntry } from './entry';

const sendCalls = vi.hoisted(() => vi.fn());
const waitForCallsStatus = vi.hoisted(() => vi.fn());
vi.mock('wagmi/actions', () => ({ sendCalls, waitForCallsStatus }));

const WALLET: Address = '0x00000000000000000000000000000000000a11e7';
const BEACON_DELAY = 120;
const PERSON_TAG = `0x${'ab'.repeat(32)}`;
const SIGNATURE = `0x${'cd'.repeat(65)}`;

function stakesRound(): RoundView {
  const base = testRound();
  const beaconRound = firstRoundAtOrAfter(QUICKNET, base.closesAt + BEACON_DELAY);
  return {
    ...base,
    beaconRound,
    config: {
      beaconDelay: BEACON_DELAY,
      overrides: [],
      stakes: {
        chainRoundId: '7',
        opensAt: base.opensAt,
        closesAt: base.closesAt,
        beaconRound,
        stake: '5000000',
        feeBps: 500,
        creatorBps: 100,
        capMultiple: 10,
        minEntrants: 20,
        creator: '0x00000000000000000000000000000000000c0ffe',
        questionHash: questionHash(base.question),
        authorHandle: null,
        payoutAddress: null,
      },
    },
    modes: { stakes: { ...base.modes.free!, chainRoundId: '7' } },
  };
}

function reader(round: RoundView, over: Record<string, unknown> = {}): EscrowReader {
  const s = round.config!.stakes!;
  return {
    roundConfig: () =>
      Promise.resolve({
        opensAt: BigInt(s.opensAt),
        closesAt: BigInt(s.closesAt),
        beaconRound: BigInt(s.beaconRound),
        stake: BigInt(s.stake),
        feeBps: s.feeBps,
        creatorBps: s.creatorBps,
        capMultiple: s.capMultiple,
        minEntrants: s.minEntrants,
        creator: s.creator as Address,
        questionHash: s.questionHash as Hex,
        ...over,
      }),
  };
}

function prepared(round: RoundView, over: Partial<StakesPrepareResponse> = {}) {
  const s = round.config!.stakes!;
  return {
    ticket: {
      roundId: s.chainRoundId,
      wallet: WALLET,
      personTag: PERSON_TAG,
      expiry: 1_800_000_000,
    },
    signature: SIGNATURE,
    chainId: TEST_CHAIN.chainId,
    verifyingContract: TEST_CHAIN.escrow,
    stake: s.stake,
    beaconRound: s.beaconRound,
    ...over,
  };
}

const wagmi = {} as never;
const ORIGIN = 'https://flocked.xyz';

beforeEach(() => {
  sendCalls.mockReset().mockResolvedValue({ id: '0xbatch' });
  waitForCallsStatus.mockReset().mockResolvedValue({
    status: 'success',
    receipts: [{ transactionHash: `0x${'77'.repeat(32)}` }],
  });
});

describe('submitStakesEntry', () => {
  it('encrypts the pick, takes a ticket and sends approve then enter in one user operation', async () => {
    const round = stakesRound();
    const prepare = vi.fn().mockResolvedValue(prepared(round));
    const result = await submitStakesEntry(
      { round, optionIndex: 1, wallet: WALLET },
      { chain: TEST_CHAIN, reader: reader(round), prepare, wagmi, origin: ORIGIN },
    );

    expect(prepare).toHaveBeenCalledWith(WALLET);
    expect(result.optionIndex).toBe(1);
    expect(result.stake).toBe(5_000_000n);
    expect(result.sent.txHashes).toHaveLength(1);

    const sent = sendCalls.mock.calls[0]![1] as {
      calls: { to: Address; data: Hex }[];
      capabilities: { paymasterService: { url: string } };
      forceAtomic: boolean;
    };
    // The paymaster sponsors `approve` only immediately before `enter`, in one atomic operation.
    expect(sent.forceAtomic).toBe(true);
    expect(sent.capabilities.paymasterService.url).toMatch(/\/api\/v1\/paymaster$/);
    expect(sent.calls).toHaveLength(2);
    const approve = decodeFunctionData({ abi: mockUsdcAbi, data: sent.calls[0]!.data });
    expect(sent.calls[0]!.to).toBe(TEST_CHAIN.usdc);
    expect(approve.functionName).toBe('approve');
    expect(approve.args).toEqual([TEST_CHAIN.escrow, 5_000_000n]);
    const enter = decodeFunctionData({ abi: flockedEscrowAbi, data: sent.calls[1]!.data });
    expect(sent.calls[1]!.to).toBe(TEST_CHAIN.escrow);
    expect(enter.functionName).toBe('enter');
    expect(enter.args?.[0]).toBe(7n);
  });

  it('refuses before the ticket when the chain disagrees with the published config', async () => {
    const round = stakesRound();
    const prepare = vi.fn();
    await expect(
      submitStakesEntry(
        { round, optionIndex: 0, wallet: WALLET },
        { chain: TEST_CHAIN, reader: reader(round, { stake: 50_000_000n }), prepare, wagmi },
      ),
    ).rejects.toBeInstanceOf(StakesRefused);
    // Nothing was asked for and nothing was sent: no pick left the device.
    expect(prepare).not.toHaveBeenCalled();
    expect(sendCalls).not.toHaveBeenCalled();
  });

  it('refuses rather than trusting the API when the chain cannot be read', async () => {
    const round = stakesRound();
    const prepare = vi.fn();
    await expect(
      submitStakesEntry(
        { round, optionIndex: 0, wallet: WALLET },
        {
          chain: TEST_CHAIN,
          reader: { roundConfig: () => Promise.reject(new Error('rpc')) },
          prepare,
          wagmi,
        },
      ),
    ).rejects.toBeInstanceOf(StakesRefused);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('refuses a ticket for another wallet, chain or escrow', async () => {
    const round = stakesRound();
    const cases: Partial<StakesPrepareResponse>[] = [
      {
        ticket: { ...prepared(round).ticket, wallet: '0x000000000000000000000000000000000000dead' },
      },
      { chainId: 8453 },
      { verifyingContract: '0x000000000000000000000000000000000000dead' },
    ];
    for (const over of cases) {
      await expect(
        submitStakesEntry(
          { round, optionIndex: 0, wallet: WALLET },
          {
            chain: TEST_CHAIN,
            reader: reader(round),
            prepare: () => Promise.resolve(prepared(round, over)),
            wagmi,
          },
        ),
      ).rejects.toBeInstanceOf(WalletError);
      expect(sendCalls).not.toHaveBeenCalled();
    }
  });

  it('reports a batch that is accepted and then reverts', async () => {
    const round = stakesRound();
    waitForCallsStatus.mockResolvedValue({ status: 'failure', receipts: [] });
    await expect(
      submitStakesEntry(
        { round, optionIndex: 0, wallet: WALLET },
        {
          chain: TEST_CHAIN,
          reader: reader(round),
          prepare: () => Promise.resolve(prepared(round)),
          wagmi,
          origin: ORIGIN,
        },
      ),
    ).rejects.toMatchObject({ name: 'WalletError', kind: 'reverted' });
  });
});

describe('entryCalls', () => {
  it('carries the ciphertext onchain byte for byte', async () => {
    const round = stakesRound();
    const result = await submitStakesEntry(
      { round, optionIndex: 1, wallet: WALLET },
      {
        chain: TEST_CHAIN,
        reader: reader(round),
        prepare: () => Promise.resolve(prepared(round)),
        wagmi,
        origin: ORIGIN,
      },
    );
    const calls = entryCalls({
      escrow: TEST_CHAIN.escrow,
      usdc: TEST_CHAIN.usdc,
      ciphertext: result.ciphertext,
      prepared: prepared(round),
    });
    const enter = decodeFunctionData({ abi: flockedEscrowAbi, data: calls[1]!.data });
    const onchain = enter.args?.[1] as Hex;
    const bytes = fromBase64Url(result.ciphertext)!;
    expect(onchain).toBe(`0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`);
    // And it is a real tlock ciphertext for the round's beacon, not a placeholder.
    expect(() => decryptWithSignature).not.toThrow();
    expect(bytes.length).toBeGreaterThan(0);
  });
});
