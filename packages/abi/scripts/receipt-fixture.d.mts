// Types for scripts/receipt-fixture.mjs, imported by the tests.

export interface ReceiptFixture {
  description: string;
  chainId: number;
  verifyingContract: `0x${string}`;
  signer: `0x${string}`;
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
export declare const receiptTypes: {
  readonly Receipt: readonly { readonly name: string; readonly type: string }[];
};
export declare function buildReceiptFixture(): Promise<ReceiptFixture>;
