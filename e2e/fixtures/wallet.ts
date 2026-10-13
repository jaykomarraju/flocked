// The `wallet` fixture (W7-D): EOAs on the stack's anvil. A fresh key per player (anvil gives it gas;
// MockUSDC mints its stakes and the escrow gets the allowance), or one of anvil's own dev accounts.
// No spec here needs a Coinbase Smart Wallet: Stakes entries are plain `enter` calls from the
// player's wallet. The paymaster's user operations (W10-D) will add an ERC-4337 stand-in here.
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import {
  createWalletClient,
  http as viemHttp,
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

/** Mints `amount` MockUSDC to the wallet and approves the escrow for it. */
export async function fundStake(stack: Stack, w: Wallet, amount: bigint): Promise<void> {
  const { usdc, escrow } = stack.contracts;
  await mined(
    stack,
    w.client.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [w.address, amount],
    }),
  );
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
