// The sponsorship allow list (spec "Smart contract" › Gas and UX). The proxy inspects the
// Coinbase Smart Wallet callData the EntryPoint will execute; targets or calls repeated in a
// provider-specific `context` are deliberately ignored.
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import { ticketDigest, type PaymasterRequest } from '@flocked/shared';
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  parseAbi,
  recoverAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { deploymentOf } from '../chain/client.js';
import type { Env } from '../env.js';
import { nowSeconds } from '../lib/clock.js';

/** The v0.6 EntryPoint used by the pinned @base-org/account Coinbase Smart Wallet. */
export const ENTRY_POINT_V06 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789' as Address;

/** CoinbaseSmartWallet v1/v1.1 execution surface. */
export const coinbaseSmartWalletAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);

export interface PaymasterUserOperation {
  sender: Address;
  nonce: Hex;
  callData: Hex;
}

interface WalletCall {
  target: Address;
  value: bigint;
  data: Hex;
}

interface TicketRow {
  ticket_hash: string;
  wallet: string;
  person_tag: string;
  expiry: number;
  chain_round_id: string;
}

interface EntryCall {
  kind: 'enter' | 'enterWithPermit';
  roundId: bigint;
  wallet: Address;
  personTag: Hex;
  expiry: bigint;
  signature: Hex;
  stake: bigint;
}

export class SponsorshipRefused extends Error {
  override readonly name = 'SponsorshipRefused';
}

const refuse = (): never => {
  throw new SponsorshipRefused('call not sponsored');
};

const hex = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);

function exactDecode(abi: Abi, data: Hex) {
  try {
    const decoded = decodeFunctionData({ abi, data });
    const encoded = encodeFunctionData({
      abi,
      functionName: decoded.functionName,
      args: decoded.args,
    });
    if (encoded.toLowerCase() !== data.toLowerCase()) refuse();
    return decoded;
  } catch (err) {
    if (err instanceof SponsorshipRefused) throw err;
    return refuse();
  }
}

/** Fields used for policy, quota identity and nothing else. */
export function userOperationOf(request: PaymasterRequest): PaymasterUserOperation {
  const userOp = request.params[0];
  const sender = userOp.sender;
  const nonce = userOp.nonce;
  const callData = userOp.callData;
  if (
    typeof sender !== 'string' ||
    !isAddress(sender, { strict: true }) ||
    !hex(nonce) ||
    nonce.length < 3 ||
    !hex(callData) ||
    callData.length < 10
  ) {
    return refuse();
  }
  try {
    BigInt(nonce);
  } catch {
    return refuse();
  }
  return {
    sender: sender.toLowerCase() as Address,
    nonce: nonce.toLowerCase() as Hex,
    callData: callData.toLowerCase() as Hex,
  };
}

/** Chain and EntryPoint are parameters, not provider context: both must match this deployment. */
export function requirePaymasterDomain(
  env: Pick<Env, 'CHAIN_ID'>,
  request: PaymasterRequest,
): void {
  const entryPoint = request.params[1].toLowerCase();
  let chainId: bigint;
  try {
    chainId = BigInt(request.params[2]);
  } catch {
    return refuse();
  }
  if (entryPoint !== ENTRY_POINT_V06 || chainId !== BigInt(env.CHAIN_ID)) refuse();
}

function walletCalls(callData: Hex): WalletCall[] {
  const outer = exactDecode(coinbaseSmartWalletAbi, callData);
  if (outer.functionName === 'execute') {
    const [target, value, data] = outer.args as readonly [Address, bigint, Hex];
    return [{ target: target.toLowerCase() as Address, value, data }];
  }
  if (outer.functionName === 'executeBatch') {
    const [calls] = outer.args as readonly [
      readonly { target: Address; value: bigint; data: Hex }[],
    ];
    if (calls.length === 0) return refuse();
    return calls.map((call) => ({
      target: call.target.toLowerCase() as Address,
      value: call.value,
      data: call.data,
    }));
  }
  return refuse();
}

function decodedEscrowCall(call: WalletCall) {
  if (call.value !== 0n) return refuse();
  return exactDecode(flockedEscrowAbi, call.data);
}

async function validateEntry(
  env: Pick<Env, 'DB' | 'CHAIN_ID' | 'LOCAL_DEPLOYMENT' | 'ENVIRONMENT' | 'FLOCKED_TEST_CLOCK'>,
  sender: Address,
  call: WalletCall,
  expectedSigner: Address,
  stakeForRound: (roundId: bigint) => Promise<bigint>,
): Promise<EntryCall> {
  const deployment = deploymentOf(env);
  if (call.target !== deployment.escrow.toLowerCase()) return refuse();
  const decoded = decodedEscrowCall(call);
  if (decoded.functionName !== 'enter' && decoded.functionName !== 'enterWithPermit')
    return refuse();

  const args = decoded.args as readonly unknown[];
  const roundId = args[0];
  const ticket = args[2] as
    { roundId?: unknown; wallet?: unknown; personTag?: unknown; expiry?: unknown } | undefined;
  const signature = args[3];
  if (
    typeof roundId !== 'bigint' ||
    !ticket ||
    typeof ticket.roundId !== 'bigint' ||
    ticket.roundId !== roundId ||
    typeof ticket.wallet !== 'string' ||
    !isAddress(ticket.wallet, { strict: true }) ||
    ticket.wallet.toLowerCase() !== sender ||
    !hex(ticket.personTag) ||
    ticket.personTag.length !== 66 ||
    BigInt(ticket.personTag) === 0n ||
    typeof ticket.expiry !== 'bigint' ||
    ticket.expiry > BigInt(Number.MAX_SAFE_INTEGER) ||
    ticket.expiry < BigInt(nowSeconds(env)) ||
    !hex(signature) ||
    signature.length !== 132
  ) {
    return refuse();
  }

  const digest = ticketDigest(
    { chainId: Number(env.CHAIN_ID), verifyingContract: deployment.escrow },
    {
      roundId,
      wallet: sender,
      personTag: ticket.personTag,
      expiry: ticket.expiry,
    },
  ).toLowerCase() as Hex;
  const row = await env.DB.prepare(
    'SELECT t.ticket_hash, t.wallet, t.person_tag, t.expiry, m.chain_round_id ' +
      'FROM stakes_tickets t JOIN rounds r ON r.id = t.round_id ' +
      "JOIN round_modes m ON m.round_id = r.id AND m.mode = 'stakes' " +
      'WHERE t.ticket_hash = ?1 AND t.used_tx IS NULL AND lower(t.wallet) = ?2 ' +
      'AND lower(t.person_tag) = ?3 AND t.expiry = ?4 AND m.chain_round_id = ?5',
  )
    .bind(digest, sender, ticket.personTag.toLowerCase(), Number(ticket.expiry), roundId.toString())
    .first<TicketRow>();
  if (!row) return refuse();

  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash: digest, signature });
  } catch {
    return refuse();
  }
  if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) return refuse();

  let stake: bigint;
  try {
    stake = await stakeForRound(roundId);
    if (stake <= 0n) return refuse();
  } catch {
    return refuse();
  }
  return {
    kind: decoded.functionName,
    roundId,
    wallet: sender,
    personTag: ticket.personTag,
    expiry: ticket.expiry,
    signature,
    stake,
  };
}

const CLAIM_CALLS = new Set(['claim', 'claimRefund', 'finalize', 'withdraw']);

/**
 * Enforces the complete allow list. Entry user operations have one of three exact shapes; a claim
 * batch contains only claim/refund/finalize/withdraw calls. No sponsored call transfers ETH.
 */
export async function validateSponsoredOperation(
  env: Pick<Env, 'DB' | 'CHAIN_ID' | 'LOCAL_DEPLOYMENT' | 'ENVIRONMENT' | 'FLOCKED_TEST_CLOCK'>,
  request: PaymasterRequest,
  expectedSigner: Address,
  stakeForRound: (roundId: bigint) => Promise<bigint>,
): Promise<PaymasterUserOperation> {
  requirePaymasterDomain(env, request);
  const userOp = userOperationOf(request);
  const calls = walletCalls(userOp.callData);
  const deployment = deploymentOf(env);
  const escrow = deployment.escrow.toLowerCase();

  // enter / enterWithPermit by itself.
  if (calls.length === 1 && calls[0]!.target === escrow) {
    const decoded = decodedEscrowCall(calls[0]!);
    if (decoded.functionName === 'enter' || decoded.functionName === 'enterWithPermit') {
      await validateEntry(env, userOp.sender, calls[0]!, expectedSigner, stakeForRound);
      return userOp;
    }
  }

  // The only approve shape: exact USDC, exact escrow spender and exact frozen stake, immediately
  // followed by enter. Nothing may precede or follow the pair.
  if (
    calls.length === 2 &&
    calls[0]!.target === deployment.usdc.toLowerCase() &&
    calls[1]!.target === escrow
  ) {
    const entry = await validateEntry(env, userOp.sender, calls[1]!, expectedSigner, stakeForRound);
    if (entry.kind !== 'enter' || calls[0]!.value !== 0n) return refuse();
    const approve = exactDecode(mockUsdcAbi, calls[0]!.data);
    if (approve.functionName !== 'approve') return refuse();
    const [spender, amount] = approve.args as readonly [Address, bigint];
    if (spender.toLowerCase() !== escrow || amount !== entry.stake) return refuse();
    return userOp;
  }

  // "Claim all" is intentionally unbounded by item count here: the provider/bundler enforces the
  // operation gas limits, while the entire atomic batch consumes one sponsorship slot.
  if (
    calls.every((call) => {
      if (call.target !== escrow || call.value !== 0n) return false;
      const decoded = decodedEscrowCall(call);
      return CLAIM_CALLS.has(decoded.functionName);
    })
  ) {
    return userOp;
  }

  return refuse();
}
