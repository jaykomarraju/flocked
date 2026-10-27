// E2E-11 (W10-D): the API is the ERC-7677 policy boundary. A real prepared Stakes ticket inside
// Coinbase Smart Wallet executeBatch calldata reaches the local provider; unrelated token calls,
// standalone approvals and tampered tickets do not. Final sponsorships stop at ten per sender/day.
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import {
  PaymasterResponseSchema,
  StakesPrepareResponseSchema,
  type PaymasterRequest,
  type PaymasterResponse,
} from '@flocked/shared';
import { bytesToHex, encodeFunctionData, type Hex } from 'viem';
import { roundRefFromChainId } from '@flocked/tlock';
import { expect, test } from '../fixtures';
import { scheduleRound, seal, waitRound } from '../fixtures/rounds';
import { auth } from '../fixtures/user';
import {
  mintStake,
  paymasterRequest,
  smartWalletUserOperation,
  stakesEntryCalls,
} from '../fixtures/wallet';

test.describe.configure({ mode: 'serial' });

interface RecordedCalls {
  calls: PaymasterRequest[];
}

async function resetProvider(origin: string): Promise<void> {
  const response = await fetch(`${origin}/calls`, { method: 'DELETE' });
  expect(response.ok).toBe(true);
}

async function providerCalls(origin: string): Promise<PaymasterRequest[]> {
  const response = await fetch(`${origin}/calls`);
  expect(response.ok).toBe(true);
  return ((await response.json()) as RecordedCalls).calls;
}

async function sponsor(
  stack: Parameters<typeof stakesEntryCalls>[0],
  request: PaymasterRequest,
): Promise<PaymasterResponse> {
  const response = await stack.api('/paymaster', { body: request });
  expect(response.status).toBe(200);
  return PaymasterResponseSchema.parse(response.body);
}

const code = (response: PaymasterResponse) => ('error' in response ? response.error.code : null);

test.describe('paymaster proxy (E2E-11)', () => {
  test.beforeAll(async ({ clock }) => {
    await clock.release();
  });

  test('sponsors only the Stakes allowlist and caps final calls at ten', async ({
    stack,
    user,
    wallet,
  }) => {
    const player = await user({ stakes: true });
    const { roundId } = await scheduleRound(stack, {
      free: false,
      stakes: { stake: '1000000', minEntrants: 3, capMultiple: 1 },
    });
    await waitRound(
      stack,
      roundId,
      'the paymaster round to open',
      90_000,
      (round) => round.status === 'open',
    );
    const preparedResponse = await stack.api(`/rounds/${roundId}/entries/stakes/prepare`, {
      ...auth(player),
      body: { wallet: player.wallet.lower },
    });
    expect(preparedResponse.status, JSON.stringify(preparedResponse.body)).toBe(200);
    const prepared = StakesPrepareResponseSchema.parse(preparedResponse.body);
    await mintStake(stack, player.wallet, BigInt(prepared.stake));
    const ciphertext = bytesToHex(
      await seal(
        stack,
        roundRefFromChainId(BigInt(prepared.ticket.roundId)),
        prepared.beaconRound,
        0,
      ),
    );
    const entryCalls = stakesEntryCalls(stack, prepared, ciphertext);

    await resetProvider(stack.bundlerUrl);
    const operation = smartWalletUserOperation(player.wallet.address, entryCalls, 0n);
    const stub = paymasterRequest(
      'pm_getPaymasterStubData',
      operation,
      stack.chainId,
      'entry-stub',
    );
    const final = paymasterRequest('pm_getPaymasterData', operation, stack.chainId, 'entry-final');
    expect(await sponsor(stack, stub)).toMatchObject({ result: { isFinal: false } });
    expect(await sponsor(stack, final)).toMatchObject({ result: { isFinal: true } });
    expect((await providerCalls(stack.bundlerUrl)).map((call) => call.method)).toEqual([
      'pm_getPaymasterStubData',
      'pm_getPaymasterData',
    ]);

    await resetProvider(stack.bundlerUrl);
    const transfer = {
      to: stack.contracts.usdc,
      data: encodeFunctionData({
        abi: mockUsdcAbi,
        functionName: 'transfer',
        args: [player.wallet.address, 1n],
      }),
    };
    const rejected = [
      smartWalletUserOperation(player.wallet.address, [transfer], 1n),
      smartWalletUserOperation(player.wallet.address, [entryCalls[0]!], 2n),
    ];
    const recovery = prepared.signature.slice(-2).toLowerCase();
    const badSignature =
      `${prepared.signature.slice(0, -2)}${recovery === '00' || recovery === '1b' ? '01' : '00'}` as Hex;
    rejected.push(
      smartWalletUserOperation(
        player.wallet.address,
        stakesEntryCalls(stack, { ...prepared, signature: badSignature }, ciphertext),
        3n,
      ),
    );
    for (const [i, bad] of rejected.entries()) {
      expect(
        code(
          await sponsor(
            stack,
            paymasterRequest('pm_getPaymasterData', bad, stack.chainId, `rejected-${i}`),
          ),
        ),
      ).toBe(-32602);
    }
    expect(await providerCalls(stack.bundlerUrl)).toEqual([]);

    await resetProvider(stack.bundlerUrl);
    const capWallet = await wallet();
    const withdraw = {
      to: stack.contracts.escrow,
      data: encodeFunctionData({ abi: flockedEscrowAbi, functionName: 'withdraw' }),
    };
    const outcomes: (number | null)[] = [];
    for (let nonce = 0; nonce < 11; nonce += 1) {
      const capped = smartWalletUserOperation(capWallet.address, [withdraw], BigInt(nonce));
      outcomes.push(
        code(
          await sponsor(
            stack,
            paymasterRequest('pm_getPaymasterData', capped, stack.chainId, `cap-${nonce}`),
          ),
        ),
      );
    }
    expect(outcomes.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => null));
    expect(outcomes[10]).toBe(-32010);
    expect(
      (await providerCalls(stack.bundlerUrl)).filter(
        (call) => call.method === 'pm_getPaymasterData',
      ),
    ).toHaveLength(10);
  });
});
