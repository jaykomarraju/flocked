// W10-D paymaster policy and quota. These tests use a ticket produced by the real Stakes prepare
// path, Coinbase Smart Wallet calldata, and an injected provider/chain reader; no secrets or RPCs.
import { env } from 'cloudflare:test';
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import {
  StakesPrepareResponseSchema,
  type PaymasterRequest,
  type StakesPrepareResponse,
} from '@flocked/shared';
import { encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { coinbaseSmartWalletAbi, ENTRY_POINT_V06 } from '../../src/paymaster/policy.js';
import { proxyPaymaster, type PaymasterProxyDeps } from '../../src/paymaster/proxy.js';
import {
  acquireSponsorship,
  commitSponsorship,
  releaseSponsorship,
  SPONSORSHIP_LEASE_MS,
} from '../../src/paymaster/quota.js';
import { deploymentOf } from '../../src/chain/client.js';
import { seedFixture } from '../helpers/index.js';
import {
  player,
  prepare,
  round,
  setStakesConfig,
  stakesTest,
  type StakesTest,
} from '../stakes/helpers.js';

const PAYMASTER = '0x0000000000000000000000000000000000004337';

beforeAll(async () => {
  await seedFixture(env.DB);
});

let t: StakesTest;
let prepared: StakesPrepareResponse;
let wallet: Address;
let requestEnv: Env;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM paymaster_sponsorships').run();
  await setStakesConfig({});
  t = stakesTest();
  const r = await round(t);
  const p = await player(t);
  wallet = p.wallet;
  const response = await prepare(t, p, r.locked.roundId, wallet);
  expect(response.status, await response.clone().text()).toBe(200);
  prepared = StakesPrepareResponseSchema.parse(await response.json());
  requestEnv = { ...t.env, PAYMASTER_URL: 'https://paymaster.example/rpc' };
});

interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

function walletCallData(calls: readonly Call[]): Hex {
  return encodeFunctionData({
    abi: coinbaseSmartWalletAbi,
    functionName: 'executeBatch',
    args: [calls],
  });
}

function userOperation(calls: readonly Call[], nonce = 0n, sender = wallet) {
  return {
    sender,
    nonce: toHex(nonce),
    initCode: '0x',
    callData: walletCallData(calls),
    callGasLimit: '0x0',
    verificationGasLimit: '0x0',
    preVerificationGas: '0x0',
    maxFeePerGas: '0x0',
    maxPriorityFeePerGas: '0x0',
    paymasterAndData: '0x',
    signature: '0x',
  };
}

function rpc(
  calls: readonly Call[],
  method: PaymasterRequest['method'] = 'pm_getPaymasterData',
  nonce = 0n,
  id: number | string = Number(nonce),
  sender = wallet,
): PaymasterRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: [
      userOperation(calls, nonce, sender),
      ENTRY_POINT_V06,
      toHex(Number(requestEnv.CHAIN_ID)),
      null,
    ],
  };
}

function enterCall(body = prepared): Call {
  return {
    target: body.verifyingContract as Address,
    value: 0n,
    data: encodeFunctionData({
      abi: flockedEscrowAbi,
      functionName: 'enter',
      args: [
        BigInt(body.ticket.roundId),
        '0x1234',
        {
          roundId: BigInt(body.ticket.roundId),
          wallet: body.ticket.wallet as Address,
          personTag: body.ticket.personTag as Hex,
          expiry: BigInt(body.ticket.expiry),
        },
        body.signature as Hex,
      ],
    }),
  };
}

function approveCall(
  amount = BigInt(prepared.stake),
  spender = prepared.verifyingContract as Address,
): Call {
  return {
    target: deploymentOf(requestEnv).usdc,
    value: 0n,
    data: encodeFunctionData({
      abi: mockUsdcAbi,
      functionName: 'approve',
      args: [spender, amount],
    }),
  };
}

function escrowCall(functionName: 'claim' | 'claimRefund' | 'finalize' | 'withdraw'): Call {
  const data =
    functionName === 'claim'
      ? encodeFunctionData({ abi: flockedEscrowAbi, functionName, args: [1n, 0, []] })
      : functionName === 'withdraw'
        ? encodeFunctionData({ abi: flockedEscrowAbi, functionName })
        : encodeFunctionData({ abi: flockedEscrowAbi, functionName, args: [1n] });
  return { target: deploymentOf(requestEnv).escrow, value: 0n, data };
}

function providerFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new TypeError('provider body is not a string');
    const body = JSON.parse(init.body) as PaymasterRequest;
    return Promise.resolve(
      Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { paymasterAndData: PAYMASTER, sponsor: { name: 'test' }, isFinal: true },
      }),
    );
  });
}

function deps(fetch = providerFetch()): PaymasterProxyDeps {
  return {
    fetch,
    ticketSigner: () => Promise.resolve(t.signer.address),
    stakeForRound: () => Promise.resolve(BigInt(prepared.stake)),
  };
}

async function call(request: PaymasterRequest, d = deps()) {
  return proxyPaymaster(requestEnv, JSON.stringify(request), d);
}

function errorCode(reply: Awaited<ReturnType<typeof call>>): number | undefined {
  return 'error' in reply.body ? reply.body.error.code : undefined;
}

describe('ERC-7677 policy', () => {
  it('forwards the exact stub and final bodies for approve immediately followed by a valid enter', async () => {
    const fetch = providerFetch();
    const calls = [approveCall(), enterCall()];
    const stub = rpc(calls, 'pm_getPaymasterStubData', 7n, 'stub');
    const final = rpc(calls, 'pm_getPaymasterData', 7n, 'final');

    const a = await call(stub, deps(fetch));
    const b = await call(final, deps(fetch));
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ result: { isFinal: false } });
    expect(b.body).toMatchObject({ result: { isFinal: true } });
    expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify(stub),
      JSON.stringify(final),
    ]);
  });

  it('accepts standalone enter and every claim-all selector', async () => {
    expect(errorCode(await call(rpc([enterCall()])))).toBeUndefined();
    await env.DB.prepare('DELETE FROM paymaster_sponsorships').run();
    expect(
      errorCode(
        await call(
          rpc(
            (['claim', 'claimRefund', 'finalize', 'withdraw'] as const).map(escrowCall),
            'pm_getPaymasterData',
            1n,
          ),
        ),
      ),
    ).toBeUndefined();
  });

  it.each([
    ['approve alone', () => [approveCall()]],
    ['wrong order', () => [enterCall(), approveCall()]],
    ['wrong amount', () => [approveCall(BigInt(prepared.stake) + 1n), enterCall()]],
    ['wrong spender', () => [approveCall(1n, wallet), enterCall()]],
    ['nonzero ETH', () => [{ ...escrowCall('withdraw'), value: 1n }]],
  ])('rejects %s before contacting the provider', async (_name, makeCalls) => {
    const fetch = providerFetch();
    expect(errorCode(await call(rpc(makeCalls()), deps(fetch)))).toBe(-32602);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unknown targets, disallowed selectors, wrong domain, and a tampered ticket', async () => {
    const transfer: Call = {
      target: deploymentOf(requestEnv).usdc,
      value: 0n,
      data: encodeFunctionData({ abi: mockUsdcAbi, functionName: 'transfer', args: [wallet, 1n] }),
    };
    expect(errorCode(await call(rpc([transfer])))).toBe(-32602);

    const wrongEntryPoint = rpc([escrowCall('withdraw')]);
    wrongEntryPoint.params[1] = '0x0000000000000000000000000000000000000001';
    expect(errorCode(await call(wrongEntryPoint))).toBe(-32602);

    const tampered = structuredClone(prepared);
    tampered.ticket.expiry += 1;
    expect(errorCode(await call(rpc([enterCall(tampered)])))).toBe(-32602);
  });
});

describe('final-call quota', () => {
  it('reclaims an expired lease and fences the stale owner from releasing or committing it', async () => {
    const key: Hex = `0x${'11'.repeat(32)}`;
    const first = await acquireSponsorship(env.DB, { key, sender: wallet, now: 1_000 });
    expect(first.kind).toBe('acquired');
    if (first.kind !== 'acquired') throw new Error('first lease was not acquired');

    expect(
      await acquireSponsorship(env.DB, {
        key,
        sender: wallet,
        now: 1_000 + SPONSORSHIP_LEASE_MS - 1,
      }),
    ).toMatchObject({ kind: 'pending' });
    const second = await acquireSponsorship(env.DB, {
      key,
      sender: wallet,
      now: 1_000 + SPONSORSHIP_LEASE_MS,
    });
    expect(second.kind).toBe('acquired');
    if (second.kind !== 'acquired') throw new Error('expired lease was not reclaimed');

    await releaseSponsorship(env.DB, first);
    expect(await commitSponsorship(env.DB, first, { stale: true }, 31_001)).toBe(false);
    expect(await commitSponsorship(env.DB, second, { sponsored: true }, 31_001)).toBe(true);
    expect(await acquireSponsorship(env.DB, { key, sender: wallet, now: 31_002 })).toMatchObject({
      kind: 'replay',
      result: { sponsored: true },
    });
  });

  it('does not count a stub, replays the same sender+nonce once, and releases provider errors', async () => {
    const operation = [escrowCall('withdraw')];
    const fetch = providerFetch();
    expect(
      errorCode(await call(rpc(operation, 'pm_getPaymasterStubData', 4n), deps(fetch))),
    ).toBeUndefined();
    expect(
      errorCode(await call(rpc(operation, 'pm_getPaymasterData', 4n), deps(fetch))),
    ).toBeUndefined();
    expect(
      errorCode(await call(rpc(operation, 'pm_getPaymasterData', 4n), deps(fetch))),
    ).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);

    const failing = vi.fn(() =>
      Promise.resolve(Response.json({ jsonrpc: '2.0', id: 9, error: { code: -1, message: 'no' } })),
    );
    expect(errorCode(await call(rpc(operation, 'pm_getPaymasterData', 9n, 9), deps(failing)))).toBe(
      -1,
    );
    expect(errorCode(await call(rpc(operation, 'pm_getPaymasterData', 9n, 9)))).toBeUndefined();
  });

  it('admits exactly ten concurrent finals per sender/day and keeps another sender independent', async () => {
    const operation = [escrowCall('finalize')];
    const fetch = providerFetch();
    const replies = await Promise.all(
      Array.from({ length: 11 }, (_, nonce) =>
        call(rpc(operation, 'pm_getPaymasterData', BigInt(nonce), nonce), deps(fetch)),
      ),
    );
    expect(replies.filter((reply) => errorCode(reply) === undefined)).toHaveLength(10);
    expect(replies.filter((reply) => errorCode(reply) === -32010)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(10);

    const other = '0x0000000000000000000000000000000000000042' as Address;
    expect(
      errorCode(await call(rpc(operation, 'pm_getPaymasterData', 0n, 'other', other))),
    ).toBeUndefined();
  });
});
