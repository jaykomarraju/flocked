import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FREE_COMMITMENT_LEAF } from '@flocked/settle';
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { receiptTypes } from '../../abi/scripts/receipt-fixture.mjs';
import receiptFixture from '../../abi/test/fixtures/receipt.json';
import {
  EIP712_NAME,
  EIP712_VERSION,
  MODE_CODES,
  RECEIPT_TYPES,
  receiptDigest,
  receiptTypedData,
  roundKey,
  TICKET_TYPES,
  ticketDigest,
  ticketTypedData,
  type TicketMessage,
} from '../src/eip712';
import { ulidToBytes, ulidToHex } from '../src/ids';
import { eip712FixtureJson, EIP712_FIXTURE_PATH } from './eip712-fixture';

const CONTRACTS = resolve(import.meta.dirname, '../../../contracts/src');
const sol = (name: string) => readFileSync(resolve(CONTRACTS, name), 'utf8');

/** `Name(type field,…)` from a viem types record with one struct and no nested types. */
function encodeType(types: Record<string, readonly { name: string; type: string }[]>): string {
  const [[name, fields] = ['', []]] = Object.entries(types);
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
}

/** The string inside `<constant> = keccak256("…")` (possibly across lines). */
function typehashString(source: string, constant: string): string {
  const m = new RegExp(`${constant}\\s*=\\s*keccak256\\(\\s*"([^"]+)"\\s*\\)`).exec(source);
  if (!m?.[1]) throw new Error(`${constant} not found`);
  return m[1];
}

describe('type strings match the contracts', () => {
  it('EntryTicket = FlockedEscrow.ENTRY_TICKET_TYPEHASH', () => {
    const s = typehashString(sol('FlockedEscrow.sol'), 'ENTRY_TICKET_TYPEHASH');
    expect(s).toBe('EntryTicket(uint256 roundId,address wallet,bytes32 personTag,uint64 expiry)');
    expect(encodeType(TICKET_TYPES)).toBe(s);
  });

  it('Receipt = FlockedAnchor.RECEIPT_TYPEHASH', () => {
    const s = typehashString(sol('FlockedAnchor.sol'), 'RECEIPT_TYPEHASH');
    expect(encodeType(RECEIPT_TYPES)).toBe(s);
  });

  it('domain name and version = EIP712("Flocked", "1") in both contracts', () => {
    for (const file of ['FlockedEscrow.sol', 'FlockedAnchor.sol']) {
      expect(sol(file)).toContain(`EIP712("${EIP712_NAME}", "${EIP712_VERSION}")`);
    }
  });

  it('RECEIPT_TYPES equals receiptTypes in packages/abi/scripts/receipt-fixture.mjs', () => {
    expect(RECEIPT_TYPES).toEqual(receiptTypes);
  });

  it('the receipt starts with the Free commitment leaf fields', () => {
    expect(RECEIPT_TYPES.Receipt.slice(0, 6).map((f) => f.type)).toEqual([...FREE_COMMITMENT_LEAF]);
  });
});

describe('receipt', () => {
  const f = receiptFixture;
  const anchor = { chainId: f.chainId, verifyingContract: getAddress(f.verifyingContract) };
  const r = {
    roundId: f.receipt.roundId as Hex,
    mode: f.receipt.mode as 0 | 1,
    userIdHash: f.receipt.userIdHash as Hex,
    stake: BigInt(f.receipt.stake),
    commitment: f.receipt.commitment as Hex,
    seq: f.receipt.seq,
    closesAt: BigInt(f.receipt.closesAt),
    beaconRound: BigInt(f.receipt.beaconRound),
  };

  it('reproduces the forge-verified digest in packages/abi/test/fixtures/receipt.json', () => {
    expect(receiptDigest(anchor, r)).toBe(f.digest);
  });

  it('recovers the fixture signer', async () => {
    const signer = await recoverTypedDataAddress({
      ...receiptTypedData(anchor, r),
      signature: f.signature as Hex,
    });
    expect(signer).toBe(f.signer);
  });
});

describe('ticket', () => {
  const escrow = {
    chainId: 84532,
    verifyingContract: getAddress('0x00000000000000000000000000000000000e5c00'),
  };
  const account = privateKeyToAccount(keccak256(stringToBytes('flocked.test.ticket-signer')));
  const ticket: TicketMessage = {
    roundId: 7n,
    wallet: getAddress('0x00000000000000000000000000000000000a11ce'),
    personTag: keccak256(stringToBytes('flocked.test.person-tag')),
    expiry: 1_791_421_200n,
  };

  it('signTypedData → recoverTypedDataAddress round-trips', async () => {
    const signature = await account.signTypedData(ticketTypedData(escrow, ticket));
    const recovered = await recoverTypedDataAddress({
      ...ticketTypedData(escrow, ticket),
      signature,
    });
    expect(recovered).toBe(account.address);
  });

  it('binds the chain ID and the verifying contract', () => {
    const d = ticketDigest(escrow, ticket);
    expect(ticketDigest({ ...escrow, chainId: 8453 }, ticket)).not.toBe(d);
    expect(
      ticketDigest(
        { ...escrow, verifyingContract: getAddress('0x00000000000000000000000000000000000a2c00') },
        ticket,
      ),
    ).not.toBe(d);
    expect(ticketDigest({ ...escrow, chainId: 84532n }, ticket)).toBe(d);
  });
});

describe('roundKey and MODE_CODES', () => {
  it('pins free = 0, stakes = 1', () => {
    expect(MODE_CODES).toEqual({ free: 0, stakes: 1 });
  });

  it('is keccak256(abi.encode(bytes16, uint8)) for a ULID, bytes16 hex or bytes', () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    // cast keccak $(cast abi-encode "f(bytes16,uint8)" 0x01563e3ab5d3d6764c61efb99302bd5b 0)
    const expected = '0x4cb56ff334c109acabcb3c9970f0bbf1e34b684d22c70496074284d1191ef2da';
    expect(roundKey(ulid, 'free')).toBe(expected);
    expect(roundKey(ulid, 0)).toBe(expected);
    expect(roundKey(ulidToHex(ulid), 'free')).toBe(expected);
    expect(roundKey(ulidToHex(ulid).toUpperCase().replace('0X', '0x'), 'free')).toBe(expected);
    expect(roundKey(ulidToBytes(ulid), 'free')).toBe(expected);
    expect(roundKey(ulid, 'stakes')).toBe(
      keccak256(
        encodeAbiParameters([{ type: 'bytes16' }, { type: 'uint8' }], [ulidToHex(ulid), 1]),
      ),
    );
  });

  it('rejects bad ids and modes', () => {
    expect(() => roundKey('not-a-ulid', 'free')).toThrow(RangeError);
    expect(() => roundKey(new Uint8Array(15), 'free')).toThrow(RangeError);
    expect(() => roundKey('01ARZ3NDEKTSV4RRFFQ69G5FAV', 2 as 0)).toThrow(RangeError);
  });
});

describe('test/fixtures/eip712.json', () => {
  it('is fresh (regenerate: pnpm --filter @flocked/shared exec tsx test/eip712-fixture.ts)', () => {
    expect(readFileSync(EIP712_FIXTURE_PATH, 'utf8')).toBe(eip712FixtureJson());
  });
});
