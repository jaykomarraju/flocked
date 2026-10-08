// Builds test/fixtures/eip712.json: one entry ticket and one entry receipt with their EIP-712 digests, for
// fixed contract addresses on Base Sepolia. A Foundry test deploys FlockedEscrow and FlockedAnchor at these
// addresses (deployCodeTo), sets vm.chainId and asserts the on-chain digests equal these. All numbers are
// decimal strings. test/eip712.test.ts checks the committed file is fresh.
//
//   pnpm --filter @flocked/shared exec tsx test/eip712-fixture.ts
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { userIdHash } from '@flocked/settle';
import { firstRoundAtOrAfter, QUICKNET } from '@flocked/tlock';
import { getAddress, keccak256, stringToBytes } from 'viem';

import { LOCKED_CONFIG_DEFAULTS } from '../src/config';
import {
  MODE_CODES,
  receiptDigest,
  roundKey,
  ticketDigest,
  type ReceiptMessage,
  type TicketMessage,
} from '../src/eip712';
import { ulidToBytes, ulidToHex } from '../src/ids';
import { dailyClosesAt } from '../src/time';

export const EIP712_FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/eip712.json',
);

export const FIXTURE_CHAIN_ID = 84532n;
export const FIXTURE_ESCROW = getAddress('0x00000000000000000000000000000000000e5c00');
export const FIXTURE_ANCHOR = getAddress('0x00000000000000000000000000000000000a2c00');
export const FIXTURE_ROUND_ULID = '01K6ZR7Q3M5V8X2N4P6R8T0W2Y';
export const FIXTURE_USER_ULID = '01JAB2C3D4E5F6G7H8J9K0M1N2';
export const FIXTURE_GAME_DAY = '2026-10-07';

export function buildEip712Fixture() {
  const closesAt = dailyClosesAt(FIXTURE_GAME_DAY);
  const beaconRound = firstRoundAtOrAfter(QUICKNET, closesAt + LOCKED_CONFIG_DEFAULTS.beaconDelay);
  const ticket: TicketMessage = {
    roundId: 7n,
    wallet: getAddress('0x00000000000000000000000000000000000a11ce'),
    personTag: keccak256(stringToBytes('flocked.test.person-tag')),
    expiry: BigInt(closesAt),
  };
  const receipt: ReceiptMessage = {
    roundId: ulidToHex(FIXTURE_ROUND_ULID),
    mode: MODE_CODES.free,
    userIdHash: userIdHash(ulidToBytes(FIXTURE_ROUND_ULID), ulidToBytes(FIXTURE_USER_ULID)),
    stake: 250n,
    commitment: keccak256(stringToBytes('tlock ciphertext bytes')),
    seq: 41,
    closesAt: BigInt(closesAt),
    beaconRound: BigInt(beaconRound),
  };
  const escrow = { chainId: FIXTURE_CHAIN_ID, verifyingContract: FIXTURE_ESCROW };
  const anchor = { chainId: FIXTURE_CHAIN_ID, verifyingContract: FIXTURE_ANCHOR };
  return {
    description:
      'EIP-712 digests from @flocked/shared (ticket: FlockedEscrow, receipt: FlockedAnchor); see packages/shared/test/eip712-fixture.ts',
    chainId: FIXTURE_CHAIN_ID.toString(),
    escrow: FIXTURE_ESCROW,
    anchor: FIXTURE_ANCHOR,
    ticket: {
      roundId: ticket.roundId.toString(),
      wallet: ticket.wallet,
      personTag: ticket.personTag,
      expiry: ticket.expiry.toString(),
    },
    ticketDigest: ticketDigest(escrow, ticket),
    receipt: {
      roundId: receipt.roundId,
      mode: String(receipt.mode),
      userIdHash: receipt.userIdHash,
      stake: receipt.stake.toString(),
      commitment: receipt.commitment,
      seq: String(receipt.seq),
      closesAt: receipt.closesAt.toString(),
      beaconRound: receipt.beaconRound.toString(),
    },
    receiptDigest: receiptDigest(anchor, receipt),
    roundUlid: FIXTURE_ROUND_ULID,
    roundKeys: {
      free: roundKey(FIXTURE_ROUND_ULID, 'free'),
      stakes: roundKey(FIXTURE_ROUND_ULID, 'stakes'),
    },
  };
}

export function eip712FixtureJson(): string {
  return `${JSON.stringify(buildEip712Fixture(), null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  writeFileSync(EIP712_FIXTURE_PATH, eip712FixtureJson());
  console.log(`wrote ${EIP712_FIXTURE_PATH}`);
}
