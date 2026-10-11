// Settlement output (wave-5 pinned interface: W5-A → W5-D, W6-A, W9-B). Spec: "Settlement and
// payout math" › Settlement output. The bundle's byte format is pinned in docs/bundle-format.md;
// these are its TypeScript shapes. Money in the bundle is a decimal string; in memory it is bigint.
import type { Mode, RoundKind } from '@flocked/shared';
import type { OptionIndex, Payout, SettlementRecord, VoidReason } from '@flocked/settle';
import type { Hex } from 'viem';

/** `bundleFormat` in every manifest and chunk; bump on any change to docs/bundle-format.md. */
export const BUNDLE_FORMAT = 1;

/** One entry after decryption and the Free checks, in seq order (W5-D writes it to `entries`). */
export interface ClassifiedEntry {
  entryId: string;
  /** null only for a foreign Stakes entry (no ticket). */
  userId: string | null;
  /** Free: the userIdHash (bytes32 hex). Stakes: the lowercase wallet. The payout account. */
  account: string;
  stake: bigint;
  /** Position in the round's entry order (Free: receipt_seq; Stakes: block, log index). */
  seq: number;
  /** null when VOID. */
  option: OptionIndex | null;
  /** The plaintext nonce (16 bytes hex) when the ciphertext opened to a valid pick, else null. */
  nonce: Hex | null;
  /** null when valid. */
  voidReason: VoidReason | null;
  /** Room rounds: counts toward the room minimum. Absent for daily rounds. */
  qualifies?: boolean;
}

/** One entry as a bundle chunk holds it (canonical JSON; see docs/bundle-format.md). */
export interface BundleEntry {
  seq: number;
  account: string;
  stake: string;
  option: OptionIndex | null;
  nonce: Hex | null;
  valid: boolean;
  voidReason: VoidReason | null;
  /** Free only: keccak256(ciphertext), the receipt's commitment. */
  commitment?: Hex;
  /** Free only: the ciphertext, base64url (Stakes ciphertexts are onchain). */
  ciphertext?: string | null;
  /** Room rounds only. */
  qualifies?: boolean;
}

export interface BundleChunk {
  bundleFormat: typeof BUNDLE_FORMAT;
  roundId: string;
  mode: Mode;
  index: number;
  entries: BundleEntry[];
}

/** Per-option totals over valid entries: headcount and stake (decimal strings). */
export interface ChunkTotals {
  n: string;
  w: string;
}

/** A bundle chunk as the manifest lists it. */
export interface ChunkRef {
  index: number;
  /** R2 key: `bundles/{roundId}/{mode}/chunk-{nnnn}.json`. */
  key: string;
  /** keccak256 of the chunk's bytes. */
  hash: Hex;
  entries: number;
  firstSeq: number;
  lastSeq: number;
  /** Option 0, option 1. */
  totals: [ChunkTotals, ChunkTotals];
  voids: number;
}

/** `SettlementRecord` with every bigint as a decimal string. */
export type RecordJson = {
  [K in keyof SettlementRecord]: SettlementRecord[K] extends bigint
    ? string
    : SettlementRecord[K] extends [bigint, bigint]
      ? [string, string]
      : SettlementRecord[K];
};

/** The manifest (canonical JSON at `bundles/{roundId}/{mode}/manifest.json`). */
export interface Manifest {
  bundleFormat: typeof BUNDLE_FORMAT;
  formulaVersion: number;
  roundId: string;
  mode: Mode;
  kind: RoundKind;
  roomId: string | null;
  /** Unix seconds. */
  closesAt: number;
  beaconRound: number;
  /** The locked config (`rounds.config_json`), parsed. */
  config: unknown;
  /** The drand chain hash and the verified signature for `beaconRound` (no relay identity). */
  drand: { chainHash: string; signature: string };
  /** Free: the anchored commitment; null for a mode with no entries. Stakes: null. */
  commitment: { root: Hex; anchorTx: Hex; entryCount: number } | null;
  /** Stakes: the onchain round and the close block (W6-A). Free: null. */
  chainRoundId: string | null;
  closeBlock: { number: number; hash: Hex } | null;
  record: RecordJson;
  /** VOID count per reason (only reasons that occur). */
  voids: Partial<Record<VoidReason, number>>;
  /** null when there are no payout leaves (no entries, or a refunded Stakes mode). */
  payoutRoot: Hex | null;
  entryCount: number;
  chunkSize: number;
  chunks: ChunkRef[];
}

/** What reduce hands the mode's apply hook (wave-5 pinned interface). */
export interface TallyResult {
  record: SettlementRecord;
  payouts: Payout[];
  entries: ClassifiedEntry[];
  manifest: Manifest;
  manifestBytes: Uint8Array;
  /** keccak256(manifestBytes). */
  bundleHash: Hex;
  chunks: ChunkRef[];
}
