import { readFileSync } from 'node:fs';
import { recoverTypedDataAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_PATH,
  buildReceiptFixture,
  receiptTypes,
  type ReceiptFixture,
} from '../scripts/receipt-fixture.mjs';

describe('receipt fixture (consumed by contracts/test/AnchorReceipt.t.sol)', () => {
  it('is reproduced by scripts/receipt-fixture.mjs', async () => {
    const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ReceiptFixture;
    expect(await buildReceiptFixture()).toEqual(committed);
  });

  it('uses the P2.2 Receipt type and recovers to the signer off-chain', async () => {
    const f = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ReceiptFixture;
    const encoded = receiptTypes.Receipt.map((p) => `${p.type} ${p.name}`).join(',');
    expect(`Receipt(${encoded})`).toBe(
      'Receipt(bytes16 roundId,uint8 mode,bytes32 userIdHash,uint64 stake,bytes32 commitment,uint32 seq,uint64 closesAt,uint64 beaconRound)',
    );
    const signer = await recoverTypedDataAddress({
      domain: {
        name: 'Flocked',
        version: '1',
        chainId: f.chainId,
        verifyingContract: f.verifyingContract,
      },
      types: receiptTypes,
      primaryType: 'Receipt',
      message: {
        ...f.receipt,
        stake: BigInt(f.receipt.stake),
        closesAt: BigInt(f.receipt.closesAt),
        beaconRound: BigInt(f.receipt.beaconRound),
      },
      signature: f.signature,
    });
    expect(signer).toBe(f.signer);
  });
});
