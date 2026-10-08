// Types for scripts/receipt-fixture.mjs, imported by the tests.

export interface ReceiptFixture {
  description: string;
  chainId: number;
  verifyingContract: `0x${string}`;
  signer: `0x${string}`;
  /** The round's ULID; `receipt.roundId` is its bytes16. */
  roundUlid: string;
  /** The user's ULID; `receipt.userIdHash` hashes its bytes16 with the round's. */
  userId: string;
  receipt: {
    roundId: `0x${string}`;
    mode: number;
    userIdHash: `0x${string}`;
    stake: number;
    commitment: `0x${string}`;
    seq: number;
    closesAt: number;
    beaconRound: number;
  };
  digest: `0x${string}`;
  signature: `0x${string}`;
}

export declare const FIXTURE_PATH: string;
export declare const TEST_KEY: `0x${string}`;
export declare const VERIFYING_CONTRACT: `0x${string}`;
export declare const CHAIN_ID: number;
export declare const ROUND_ULID: string;
export declare const USER_ID: string;
export declare function ulidToBytes(ulid: string): Uint8Array;
export declare function userIdHash(roundUlid: string, userUlid: string): `0x${string}`;
export declare const receiptTypes: {
  readonly Receipt: readonly { readonly name: string; readonly type: string }[];
};
export declare function buildReceiptFixture(): Promise<ReceiptFixture>;
