// The `wallet` fixture (W7-D): EOAs on the stack's anvil. A fresh key per player (anvil gives it gas;
// MockUSDC mints its stakes and the escrow gets the allowance), or one of anvil's own dev accounts.
// API-level Stakes entries usually send plain `enter` calls from the player's wallet. E2E-11 also
// builds Coinbase Smart Wallet `executeBatch` calldata around those calls, as an ERC-4337 user
// operation that the paymaster can inspect without broadcasting it.
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import type { PaymasterRequest, StakesPrepareResponse } from '@flocked/shared';
import {
  createWalletClient,
  encodeFunctionData,
  http as viemHttp,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import {
  generatePrivateKey,
  mnemonicToAccount,
  privateKeyToAccount,
  type HDAccount,
  type PrivateKeyAccount,
} from 'viem/accounts';
import { foundry } from 'viem/chains';
import type { Stack } from './stack';

/** anvil's default dev mnemonic (its first account deploys the contracts on the stack). */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

export interface Wallet {
  account: PrivateKeyAccount | HDAccount;
  /** Checksummed. */
  address: Address;
  /** Lowercase, as the API stores and answers addresses. */
  lower: Address;
  client: WalletClient<ReturnType<typeof viemHttp>, typeof foundry, PrivateKeyAccount | HDAccount>;
  /** The private key of a generated wallet (a throwaway test key), so a later phase can reuse it. */
  key?: Hex;
}

/** Canonical EntryPoint v0.6 used by the pinned Coinbase Smart Wallet package. */
export const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789' as Address;

/** The Coinbase Smart Wallet calls the paymaster decodes from `userOperation.callData`. */
export const coinbaseSmartWalletAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'executeBatch',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export interface SmartWalletCall {
  to: Address;
  data: Hex;
  value?: bigint;
}

/** A complete v0.6 user operation with placeholder gas and signature fields for E2E-11. */
export interface SmartWalletUserOperation {
  [key: string]: unknown;
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

/** Coinbase Smart Wallet `executeBatch`, keeping even a one-call operation in the same shape. */
export function smartWalletUserOperation(
  sender: Address,
  calls: readonly SmartWalletCall[],
  nonce = 0n,
): SmartWalletUserOperation {
  return {
    sender,
    nonce: toHex(nonce),
    initCode: '0x',
    callData: encodeFunctionData({
      abi: coinbaseSmartWalletAbi,
      functionName: 'executeBatch',
      args: [calls.map((call) => ({ target: call.to, value: call.value ?? 0n, data: call.data }))],
    }),
    callGasLimit: '0x0',
    verificationGasLimit: '0x0',
    preVerificationGas: '0x0',
    maxFeePerGas: '0x0',
    maxPriorityFeePerGas: '0x0',
    paymasterAndData: '0x',
    signature: `0x${'00'.repeat(65)}`,
  };
}

/** An ERC-7677 request exactly as Coinbase's wallet sends it to the app's proxy. */
export function paymasterRequest(
  method: PaymasterRequest['method'],
  userOperation: SmartWalletUserOperation,
  chainId: number,
  id: string | number,
): PaymasterRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: [userOperation, ENTRY_POINT_V06, toHex(chainId), null],
  };
}

/** The exact inner calls of a sponsored Stakes entry: approve immediately followed by enter. */
export function stakesEntryCalls(
  stack: Stack,
  prepared: StakesPrepareResponse,
  ciphertext: Hex,
): SmartWalletCall[] {
  const stake = BigInt(prepared.stake);
  const { ticket } = prepared;
  return [
    {
      to: stack.contracts.usdc,
      data: encodeFunctionData({
        abi: mockUsdcAbi,
        functionName: 'approve',
        args: [stack.contracts.escrow, stake],
      }),
    },
    {
      to: stack.contracts.escrow,
      data: encodeFunctionData({
        abi: flockedEscrowAbi,
        functionName: 'enter',
        args: [
          BigInt(ticket.roundId),
          ciphertext,
          {
            roundId: BigInt(ticket.roundId),
            wallet: ticket.wallet as Address,
            personTag: ticket.personTag as Hex,
            expiry: BigInt(ticket.expiry),
          },
          prepared.signature as Hex,
        ],
      }),
    },
  ];
}

function wrap(stack: Stack, account: PrivateKeyAccount | HDAccount, key?: Hex): Wallet {
  return {
    ...(key ? { key } : {}),
    account,
    address: account.address,
    lower: account.address.toLowerCase() as Address,
    client: createWalletClient({ account, chain: foundry, transport: viemHttp(stack.rpcUrl) }),
  };
}

/** A new EOA with 1 ETH of gas on anvil. */
export async function newWallet(stack: Stack): Promise<Wallet> {
  const key = generatePrivateKey();
  const w = wrap(stack, privateKeyToAccount(key), key);
  await stack.testClient.setBalance({ address: w.address, value: 10n ** 18n });
  return w;
}

/** A generated wallet again, from its key (a spec's `api-warp` phase; phase.ts). */
export function walletFromKey(stack: Stack, key: Hex): Wallet {
  return wrap(stack, privateKeyToAccount(key), key);
}

/** anvil's dev account `index` (1 and up; 0 is the stack's deployer). */
export function anvilWallet(stack: Stack, index: number): Wallet {
  if (index < 1) throw new Error('anvil account 0 deploys the stack; use 1 or later');
  return wrap(stack, mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }));
}

/** Waits for a transaction and fails unless it succeeded. */
export async function mined(stack: Stack, hash: Hex | Promise<Hex>): Promise<TransactionReceipt> {
  const receipt = await stack.client.waitForTransactionReceipt({ hash: await hash });
  if (receipt.status !== 'success')
    throw new Error(`transaction ${receipt.transactionHash} reverted`);
  return receipt;
}

/** Mints `amount` MockUSDC without approving it (the smart-wallet batch does the approval). */
export async function mintStake(stack: Stack, w: Wallet, amount: bigint): Promise<void> {
  const { usdc } = stack.contracts;
  await mined(
    stack,
    w.client.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [w.address, amount],
    }),
  );
}

/** Mints `amount` MockUSDC to the wallet and approves the escrow for it. */
export async function fundStake(stack: Stack, w: Wallet, amount: bigint): Promise<void> {
  const { usdc, escrow } = stack.contracts;
  await mintStake(stack, w, amount);
  await mined(
    stack,
    w.client.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'approve',
      args: [escrow, amount],
    }),
  );
}

/** The wallet's MockUSDC balance. */
export function usdcBalance(stack: Stack, address: Address): Promise<bigint> {
  return stack.client.readContract({
    address: stack.contracts.usdc,
    abi: mockUsdcAbi,
    functionName: 'balanceOf',
    args: [address],
  });
}

/** The escrow's view of a round (`getRound`). */
export function escrowRound(stack: Stack, chainRoundId: bigint) {
  return stack.client.readContract({
    address: stack.contracts.escrow,
    abi: flockedEscrowAbi,
    functionName: 'getRound',
    args: [chainRoundId],
  });
}

/** FlockedEscrow's `Status` enum. */
export const ESCROW_STATUS = {
  None: 0,
  Open: 1,
  SettleProposed: 2,
  RefundProposed: 3,
  Settled: 4,
  Refunded: 5,
} as const;

/** FlockedEscrow's `Kind` enum (claim leaves). */
export const ESCROW_KIND = { win: 0, rebate: 1, void_refund: 2 } as const;

/**
 * Sends one transaction as a stack role the specs hold no key for (the guardian, whose key
 * `stack:up` generates and drops): anvil impersonates the address for the call.
 */
export async function asRole(
  stack: Stack,
  address: Address,
  send: (
    client: WalletClient<
      ReturnType<typeof viemHttp>,
      typeof foundry,
      { address: Address; type: 'json-rpc' }
    >,
  ) => Promise<Hex>,
): Promise<TransactionReceipt> {
  await stack.testClient.impersonateAccount({ address });
  await stack.testClient.setBalance({ address, value: 10n ** 18n });
  try {
    const client = createWalletClient({
      account: { address, type: 'json-rpc' },
      chain: foundry,
      transport: viemHttp(stack.rpcUrl),
    });
    return await mined(stack, send(client));
  } finally {
    await stack.testClient.stopImpersonatingAccount({ address });
  }
}
