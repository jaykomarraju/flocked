// Free entry receipts (spec "Sealed picks" › Free mode specifics): an EIP-712 `Receipt` signed with
// RECEIPT_SIGNER_KEY over the domain ("Flocked", "1", CHAIN_ID, FlockedAnchor). The typed data comes
// from @flocked/shared's builder, the user hash from @flocked/settle, so receipts, the commitment tree
// and `FlockedAnchor.verifyReceipt` agree byte for byte (packages/abi/test/fixtures/receipt.json).
import { addressesFor, LOCAL_CHAIN_ID } from '@flocked/abi';
import { userIdHash } from '@flocked/settle';
import {
  MODE_CODES,
  receiptTypedData,
  ulidToBytes,
  ulidToHex,
  type Eip712Target,
  type FreeReceiptWire,
  type ReceiptMessage,
} from '@flocked/shared';
import { recoverTypedDataAddress, type Hex, type PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Env } from '../env.js';

/**
 * What receipt signing reads from the environment. `LOCAL_DEPLOYMENT` is the JSON of
 * `contracts/deployments/31337.json` (local chain only, written by the local stack); staging and
 * production use the committed deployments in @flocked/abi.
 */
export type ReceiptEnv = Pick<Env, 'CHAIN_ID' | 'RECEIPT_SIGNER_KEY'> & {
  LOCAL_DEPLOYMENT?: string;
};

/** The fields of one Free receipt, before signing. */
export interface FreeReceiptFields {
  roundId: string;
  userId: string;
  /** Points, a positive integer. */
  stake: bigint;
  /** keccak256 of the ciphertext. */
  commitment: Hex;
  seq: number;
  /** Unix seconds. */
  closesAtSec: number;
  beaconRound: number;
}

export interface ReceiptSigner {
  readonly target: Eip712Target;
  /** Lowercase signer address (the wire's `signer`). */
  readonly address: Hex;
  sign(fields: FreeReceiptFields): Promise<FreeReceiptWire>;
}

const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** The deployment's chain ID and FlockedAnchor address, or an Error naming what is missing. */
export function receiptTarget(env: ReceiptEnv): Eip712Target | Error {
  const chainId = Number(env.CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId < 1) return new Error('CHAIN_ID is not set');
  try {
    const local: unknown =
      chainId === LOCAL_CHAIN_ID && env.LOCAL_DEPLOYMENT !== undefined
        ? JSON.parse(env.LOCAL_DEPLOYMENT)
        : undefined;
    const { anchor } = addressesFor(chainId, local);
    return { chainId, verifyingContract: anchor.toLowerCase() as Hex };
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** keccak256(abi.encode(bytes16 roundId, bytes16 userId)) over the binary ULIDs. */
export function receiptUserIdHash(roundId: string, userId: string): Hex {
  return userIdHash(ulidToBytes(roundId), ulidToBytes(userId));
}

/** The EIP-712 message for `fields` (mode Free = 0). */
export function freeReceiptMessage(fields: FreeReceiptFields): ReceiptMessage {
  return {
    roundId: ulidToHex(fields.roundId),
    mode: MODE_CODES.free,
    userIdHash: receiptUserIdHash(fields.roundId, fields.userId),
    stake: fields.stake,
    commitment: fields.commitment,
    seq: fields.seq,
    closesAt: BigInt(fields.closesAtSec),
    beaconRound: BigInt(fields.beaconRound),
  };
}

function wireOf(
  fields: FreeReceiptFields,
  message: ReceiptMessage,
  signature: Hex,
  address: Hex,
  target: Eip712Target,
): FreeReceiptWire {
  return {
    roundId: fields.roundId,
    mode: 'free',
    userIdHash: message.userIdHash,
    stake: fields.stake.toString(),
    commitment: fields.commitment,
    seq: fields.seq,
    closesAt: fields.closesAtSec,
    beaconRound: fields.beaconRound,
    signature,
    signer: address,
    chainId: Number(target.chainId),
    verifyingContract: target.verifyingContract.toLowerCase(),
  };
}

/** A signer from a private key and target (tests and `receiptSigner`). */
export function signerFromKey(key: Hex, target: Eip712Target): ReceiptSigner {
  const account: PrivateKeyAccount = privateKeyToAccount(key);
  const address = account.address.toLowerCase() as Hex;
  return {
    target,
    address,
    async sign(fields) {
      const message = freeReceiptMessage(fields);
      const signature = await account.signTypedData(receiptTypedData(target, message));
      return wireOf(fields, message, signature, address, target);
    },
  };
}

/**
 * The receipt signer for this environment, or an Error when the key or the anchor address is
 * missing. Entries must not commit without one: an entry the server cannot sign for is refused.
 */
export function receiptSigner(env: ReceiptEnv): ReceiptSigner | Error {
  const key = env.RECEIPT_SIGNER_KEY?.trim();
  if (!key || !KEY_RE.test(key)) return new Error('RECEIPT_SIGNER_KEY is not set');
  const target = receiptTarget(env);
  if (target instanceof Error) return target;
  return signerFromKey((key.startsWith('0x') ? key : `0x${key}`) as Hex, target);
}

/** Recovers a wire receipt's signer (lowercase), as a client or the Verify page does. */
export async function recoverReceiptSigner(r: FreeReceiptWire): Promise<Hex> {
  const target = { chainId: r.chainId, verifyingContract: r.verifyingContract as Hex };
  const message: ReceiptMessage = {
    roundId: ulidToHex(r.roundId),
    mode: MODE_CODES.free,
    userIdHash: r.userIdHash as Hex,
    stake: BigInt(r.stake),
    commitment: r.commitment as Hex,
    seq: r.seq,
    closesAt: BigInt(r.closesAt),
    beaconRound: BigInt(r.beaconRound),
  };
  const address = await recoverTypedDataAddress({
    ...receiptTypedData(target, message),
    signature: r.signature as Hex,
  });
  return address.toLowerCase() as Hex;
}
