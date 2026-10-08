// EIP-712 typed data for the two signed messages. Spec: "Smart contract" (`EntryTicket`, FlockedEscrow;
// `roundKey`, FlockedAnchor) and "Sealed picks" › Free mode specifics (the entry receipt). Both contracts use
// OpenZeppelin `EIP712("Flocked", "1")`; the chain ID and verifying contract come from the deployment.
import { encodeAbiParameters, hashTypedData, keccak256, type Address, type Hex } from 'viem';

import type { Mode } from './enums';
import { ulidToHex } from './ids';

/** EIP-712 domain name and version, shared by FlockedEscrow and FlockedAnchor. */
export const EIP712_NAME = 'Flocked';
export const EIP712_VERSION = '1';

/** Where a message is verified: the deployment's chain ID and the contract address. */
export interface Eip712Target {
  chainId: number | bigint;
  verifyingContract: Address;
}

/** The full EIP-712 domain for `target`. */
export function flockedDomain(target: Eip712Target) {
  return {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId: BigInt(target.chainId),
    verifyingContract: target.verifyingContract,
  } as const;
}

/**
 * The anchor's `uint8 mode` (receipts, `roundKey`) and the Free commitment leaf: free = 0, stakes = 1.
 * Matches `FreeCommitmentLeaf.mode` in @flocked/settle.
 */
export const MODE_CODES = { free: 0, stakes: 1 } as const satisfies Record<Mode, number>;
export type ModeCode = (typeof MODE_CODES)[Mode];

// ---- Entry ticket (FlockedEscrow) ----

/** `EntryTicket(uint256 roundId,address wallet,bytes32 personTag,uint64 expiry)`. */
export const TICKET_TYPES = {
  EntryTicket: [
    { name: 'roundId', type: 'uint256' },
    { name: 'wallet', type: 'address' },
    { name: 'personTag', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

export interface TicketMessage {
  /** Onchain round ID (`chain_round_id`). */
  roundId: bigint;
  wallet: Address;
  /** Per-round person tag (spec: "Identity and personhood"). */
  personTag: Hex;
  /** Unix seconds. */
  expiry: bigint;
}

/** Typed data for viem `signTypedData` / `recoverTypedDataAddress`, verified by FlockedEscrow. */
export function ticketTypedData(escrow: Eip712Target, ticket: TicketMessage) {
  return {
    domain: flockedDomain(escrow),
    types: TICKET_TYPES,
    primaryType: 'EntryTicket',
    message: ticket,
  } as const;
}

/** The EIP-712 digest FlockedEscrow recovers the ticket signer from. */
export function ticketDigest(escrow: Eip712Target, ticket: TicketMessage): Hex {
  return hashTypedData(ticketTypedData(escrow, ticket));
}

// ---- Entry receipt (FlockedAnchor) ----

/**
 * `Receipt(bytes16 roundId,uint8 mode,bytes32 userIdHash,uint64 stake,bytes32 commitment,uint32 seq,
 * uint64 closesAt,uint64 beaconRound)`.
 */
export const RECEIPT_TYPES = {
  Receipt: [
    { name: 'roundId', type: 'bytes16' },
    { name: 'mode', type: 'uint8' },
    { name: 'userIdHash', type: 'bytes32' },
    { name: 'stake', type: 'uint64' },
    { name: 'commitment', type: 'bytes32' },
    { name: 'seq', type: 'uint32' },
    { name: 'closesAt', type: 'uint64' },
    { name: 'beaconRound', type: 'uint64' },
  ],
} as const;

export interface ReceiptMessage {
  /** The round's binary ULID as bytes16 hex (see `ulidToHex`). */
  roundId: Hex;
  mode: ModeCode;
  /** keccak256(abi.encode(roundId, userId)). */
  userIdHash: Hex;
  stake: bigint;
  /** keccak256 of the ciphertext. */
  commitment: Hex;
  /** The entry's sequence number in the round. */
  seq: number;
  /** Unix seconds. */
  closesAt: bigint;
  beaconRound: bigint;
}

/** Typed data for viem `signTypedData` / `recoverTypedDataAddress`, verified against FlockedAnchor. */
export function receiptTypedData(anchor: Eip712Target, receipt: ReceiptMessage) {
  return {
    domain: flockedDomain(anchor),
    types: RECEIPT_TYPES,
    primaryType: 'Receipt',
    message: receipt,
  } as const;
}

/** The EIP-712 digest of a receipt (`FlockedAnchor.verifyReceipt` recovers the signer from it). */
export function receiptDigest(anchor: Eip712Target, receipt: ReceiptMessage): Hex {
  return hashTypedData(receiptTypedData(anchor, receipt));
}

// ---- Anchor round key ----

/**
 * `roundKey = keccak256(abi.encode(bytes16 roundId, uint8 mode))`, the FlockedAnchor key per round and mode.
 * `roundId` is a ULID, bytes16 hex or 16 bytes.
 */
export function roundKey(roundId: string | Uint8Array, mode: Mode | ModeCode): Hex {
  const id = toBytes16Hex(roundId);
  const code = typeof mode === 'string' ? MODE_CODES[mode] : mode;
  if (code !== 0 && code !== 1) throw new RangeError(`bad mode ${String(code)}`);
  return keccak256(encodeAbiParameters([{ type: 'bytes16' }, { type: 'uint8' }], [id, code]));
}

function toBytes16Hex(id: string | Uint8Array): Hex {
  if (id instanceof Uint8Array) {
    if (id.length !== 16) throw new RangeError('roundId must be 16 bytes');
    let hex = '0x';
    for (const b of id) hex += b.toString(16).padStart(2, '0');
    return hex as Hex;
  }
  if (/^0x[0-9a-fA-F]{32}$/.test(id)) return id.toLowerCase() as Hex;
  return ulidToHex(id);
}
