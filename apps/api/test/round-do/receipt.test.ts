// Receipts (spec "Sealed picks" › Free mode specifics): built with @flocked/shared's EIP-712 builder
// and @flocked/settle's userIdHash, they match packages/abi/test/fixtures/receipt.json byte for byte,
// which contracts/test/AnchorReceipt.t.sol checks on-chain through FlockedAnchor.verifyReceipt.
import { ulidToHex } from '@flocked/shared';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { keccak256, stringToBytes } from 'viem';
import {
  receiptSigner,
  receiptTarget,
  receiptUserIdHash,
  recoverReceiptSigner,
  signerFromKey,
} from '../../src/crypto/receipt.js';
import fixture from '../../../../packages/abi/test/fixtures/receipt.json';

/** The fixture's throwaway key (packages/abi/scripts/receipt-fixture.mjs `TEST_KEY`). */
const TEST_KEY = keccak256(stringToBytes('flocked.test.receipt-signer'));

const target = {
  chainId: fixture.chainId,
  verifyingContract: fixture.verifyingContract as Hex,
};

describe('receipts match the contract-verified fixture', () => {
  it('reproduces the fixture signature with the shared builder and settle userIdHash', async () => {
    expect(ulidToHex(fixture.roundUlid)).toBe(fixture.receipt.roundId);
    expect(receiptUserIdHash(fixture.roundUlid, fixture.userId)).toBe(fixture.receipt.userIdHash);
    const signer = signerFromKey(TEST_KEY, target);
    expect(signer.address).toBe(fixture.signer.toLowerCase());
    const wire = await signer.sign({
      roundId: fixture.roundUlid,
      userId: fixture.userId,
      stake: BigInt(fixture.receipt.stake),
      commitment: fixture.receipt.commitment as Hex,
      seq: fixture.receipt.seq,
      closesAtSec: fixture.receipt.closesAt,
      beaconRound: fixture.receipt.beaconRound,
    });
    expect(wire.signature).toBe(fixture.signature);
    expect(wire).toMatchObject({
      roundId: fixture.roundUlid,
      mode: 'free',
      userIdHash: fixture.receipt.userIdHash,
      stake: String(fixture.receipt.stake),
      seq: fixture.receipt.seq,
      closesAt: fixture.receipt.closesAt,
      beaconRound: fixture.receipt.beaconRound,
      chainId: fixture.chainId,
      verifyingContract: fixture.verifyingContract,
    });
    expect(await recoverReceiptSigner(wire)).toBe(fixture.signer.toLowerCase());
  });

  it('a receipt with any field changed recovers to another address', async () => {
    const signer = signerFromKey(TEST_KEY, target);
    const wire = await signer.sign({
      roundId: fixture.roundUlid,
      userId: fixture.userId,
      stake: 250n,
      commitment: fixture.receipt.commitment as Hex,
      seq: 41,
      closesAtSec: fixture.receipt.closesAt,
      beaconRound: fixture.receipt.beaconRound,
    });
    for (const edit of [{ seq: 42 }, { stake: '251' }, { beaconRound: wire.beaconRound + 1 }]) {
      expect(await recoverReceiptSigner({ ...wire, ...edit })).not.toBe(signer.address);
    }
  });
});

describe('signer configuration', () => {
  const local = JSON.stringify({
    escrow: '0x0000000000000000000000000000000000000001',
    anchor: '0xF10CCED000000000000000000000000000000001',
    usdc: '0x0000000000000000000000000000000000000002',
    deployBlock: 0,
  });

  it('uses the local deployment on 31337 (lowercased) and refuses without one', () => {
    expect(receiptTarget({ CHAIN_ID: '31337', LOCAL_DEPLOYMENT: local })).toEqual({
      chainId: 31337,
      verifyingContract: '0xf10cced000000000000000000000000000000001',
    });
    expect(receiptTarget({ CHAIN_ID: '31337' })).toBeInstanceOf(Error);
    // No committed deployment for Base Sepolia yet (W14-A).
    expect(receiptTarget({ CHAIN_ID: '84532' })).toBeInstanceOf(Error);
  });

  it('refuses without a well-formed RECEIPT_SIGNER_KEY', () => {
    const base = { CHAIN_ID: '31337', LOCAL_DEPLOYMENT: local };
    expect(receiptSigner(base)).toBeInstanceOf(Error);
    expect(receiptSigner({ ...base, RECEIPT_SIGNER_KEY: '0x1234' })).toBeInstanceOf(Error);
    const s = receiptSigner({ ...base, RECEIPT_SIGNER_KEY: TEST_KEY.slice(2) });
    expect(s).not.toBeInstanceOf(Error);
    expect((s as { address: string }).address).toBe(fixture.signer.toLowerCase());
  });
});
