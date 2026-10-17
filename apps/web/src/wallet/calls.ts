// The calls the app asks the smart wallet to batch (spec "Smart contract" › Gas and UX, and the
// paymaster's allow list in wave-10 "Pinned interfaces"):
//   - an entry is `approve(FlockedEscrow, stake)` immediately followed by `enter`, in that order
//     and nothing else, which is the only shape the paymaster sponsors;
//   - a claim is `claim(roundId, kind, proof)` for a win, rebate or void refund, and
//     `claimRefund(roundId)` for a refunded round, which takes no proof.
// Every address and amount comes from the client's own trusted chain and from `/claims`, never from
// a wallet or a page that could suggest another destination.
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import type { ClaimItem, PayoutKind, RoomClaimItem, StakesPrepareResponse } from '@flocked/shared';
import { fromBase64Url } from '@flocked/tlock';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { WalletCall } from './send';

/** `IFlockedEscrow.Kind`, in the contract's order; `refund` is `claimRefund`, not a `Kind`. */
const CLAIM_KIND: Partial<Record<PayoutKind, number>> = {
  win: 0,
  rebate: 1,
  void_refund: 2,
};

/** The posted base64url ciphertext as the `bytes` the escrow stores. */
function ciphertextHex(base64url: string): Hex {
  const bytes = fromBase64Url(base64url);
  if (!bytes) throw new Error('ciphertext: not base64url');
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return `0x${out}` as Hex;
}

/** USDC's ERC-20 `approve`, taken from the MockUSDC ABI the deploy scripts generate. */
function approveCall(usdc: Address, escrow: Address, stake: bigint): WalletCall {
  return {
    to: usdc,
    data: encodeFunctionData({
      abi: mockUsdcAbi,
      functionName: 'approve',
      args: [escrow, stake],
    }),
  };
}

/**
 * The entry batch: `approve` for exactly the round's stake, then `enter` with the ticket the signer
 * issued. `ciphertext` is the binary age file the client encrypted, base64url as it is posted.
 */
export function entryCalls(i: {
  escrow: Address;
  usdc: Address;
  ciphertext: string;
  prepared: StakesPrepareResponse;
}): WalletCall[] {
  const { ticket, signature } = i.prepared;
  const stake = BigInt(i.prepared.stake);
  return [
    approveCall(i.usdc, i.escrow, stake),
    {
      to: i.escrow,
      data: encodeFunctionData({
        abi: flockedEscrowAbi,
        functionName: 'enter',
        args: [
          BigInt(ticket.roundId),
          ciphertextHex(i.ciphertext),
          {
            roundId: BigInt(ticket.roundId),
            wallet: ticket.wallet as Address,
            personTag: ticket.personTag as Hex,
            expiry: BigInt(ticket.expiry),
          },
          signature as Hex,
        ],
      }),
    },
  ];
}

/** What claiming needs from a `/claims` row, shared by account claims and wallet-only room claims. */
export type Claimable = Pick<ClaimItem, 'chainRoundId' | 'kind' | 'proof'> &
  Partial<Pick<RoomClaimItem, 'account'>>;

/** The one call that claims a payout: `claimRefund` for a refund, else `claim` with its proof. */
export function claimCall(escrow: Address, item: Claimable): WalletCall {
  const roundId = BigInt(item.chainRoundId);
  if (item.kind === 'refund') {
    return {
      to: escrow,
      data: encodeFunctionData({
        abi: flockedEscrowAbi,
        functionName: 'claimRefund',
        args: [roundId],
      }),
    };
  }
  const kind = CLAIM_KIND[item.kind];
  if (kind === undefined) throw new Error(`no claim call for ${item.kind}`);
  return {
    to: escrow,
    data: encodeFunctionData({
      abi: flockedEscrowAbi,
      functionName: 'claim',
      args: [roundId, kind, (item.proof ?? []) as Hex[]],
    }),
  };
}

/** "Claim all": every ready payout in one batch, so the daily sponsorship cap counts it once. */
export function claimCalls(escrow: Address, items: readonly Claimable[]): WalletCall[] {
  return items.map((item) => claimCall(escrow, item));
}
