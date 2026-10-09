#!/usr/bin/env node
// Signs one entry receipt with viem's signTypedData (the P2.2 Receipt type and domain) and writes it to
// test/fixtures/receipt.json. contracts/test/AnchorReceipt.t.sol checks that it recovers on-chain through
// FlockedAnchor.verifyReceipt, and test/receipt.test.ts checks that this script still reproduces the file.
//
//   node packages/abi/scripts/receipt-fixture.mjs

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bytesToHex, encodeAbiParameters, hashTypedData, keccak256, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/receipt.json',
);

/** A throwaway key derived from a public label, as in the Foundry tests. Never a real signer. */
export const TEST_KEY = keccak256(stringToBytes('flocked.test.receipt-signer'));

/** Where the Foundry test places FlockedAnchor (deployCodeTo) so the domain matches. */
export const VERIFYING_CONTRACT = '0xf10cced000000000000000000000000000000001';
export const CHAIN_ID = 31337;

/** The receipt's round and user, as ULIDs (the round's bytes16 is `ulidToBytes(ROUND_ULID)`). */
export const ROUND_ULID = '01JBRW99XKFS0B5GEKWKTTDDY8';
export const USER_ID = '01JAB2C3D4E5F6G7H8J9K0M1N2';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A canonical ULID's 16-byte big-endian binary form (as `ulidToBytes` in @flocked/shared). */
export function ulidToBytes(ulid) {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(ulid)) throw new RangeError(`not a ULID: ${ulid}`);
  let n = 0n;
  for (const ch of ulid) n = (n << 5n) | BigInt(CROCKFORD.indexOf(ch));
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * userIdHash = keccak256(abi.encode(bytes16 roundId, bytes16 userId)) over the binary ULIDs, as
 * `userIdHash` in @flocked/settle and the spec ("Free mode specifics").
 */
export function userIdHash(roundUlid, userUlid) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes16' }, { type: 'bytes16' }],
      [bytesToHex(ulidToBytes(roundUlid)), bytesToHex(ulidToBytes(userUlid))],
    ),
  );
}

export const receiptTypes = {
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
};

export async function buildReceiptFixture() {
  const account = privateKeyToAccount(TEST_KEY);
  const roundId = bytesToHex(ulidToBytes(ROUND_ULID));
  const message = {
    roundId,
    mode: 0,
    userIdHash: userIdHash(ROUND_ULID, USER_ID),
    stake: 250n,
    commitment: keccak256(stringToBytes('tlock ciphertext bytes')),
    seq: 41,
    closesAt: 1_760_003_600n,
    beaconRound: 22_390_119n,
  };
  const domain = {
    name: 'Flocked',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
  };
  const typedData = { domain, types: receiptTypes, primaryType: 'Receipt', message };
  const signature = await account.signTypedData(typedData);
  return {
    description:
      'Entry receipt signed with viem signTypedData; see packages/abi/scripts/receipt-fixture.mjs',
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    signer: account.address,
    roundUlid: ROUND_ULID,
    userId: USER_ID,
    receipt: {
      roundId,
      mode: message.mode,
      userIdHash: message.userIdHash,
      stake: Number(message.stake),
      commitment: message.commitment,
      seq: message.seq,
      closesAt: Number(message.closesAt),
      beaconRound: Number(message.beaconRound),
    },
    digest: hashTypedData(typedData),
    signature,
  };
}

async function main() {
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(await buildReceiptFixture(), null, 2)}\n`);
  console.log(`wrote ${FIXTURE_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
