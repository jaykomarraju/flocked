import type { Mode, SettlementRecord } from '@flocked/settle';
import type { DrandChain } from '@flocked/tlock';
import type { Hex } from 'viem';
import type { ChainReader } from './chain.js';

/**
 * One check's result. `fail` is a proven mismatch; `error` means the check could not run (data missing,
 * not yet anchored or proposed, an RPC or fetch failure); `skip` means it does not apply.
 */
export type CheckStatus = 'pass' | 'fail' | 'error' | 'skip';

export interface Check {
  /** Stable id, e.g. `chunk.hash`, `entry.voidReason`, `anchor.manifestHash`. */
  id: string;
  status: CheckStatus;
  detail?: string;
  expected?: string;
  actual?: string;
}

/** match: every check passed. mismatch: at least one failed. unverifiable: none failed, one couldn't run. */
export type Verdict = 'match' | 'mismatch' | 'unverifiable';

/** CLI exit codes: 0 match, 1 mismatch, 2 unable to verify. */
export const EXIT_CODES: Readonly<Record<Verdict, 0 | 1 | 2>> = Object.freeze({
  match: 0,
  mismatch: 1,
  unverifiable: 2,
});

/** One FlockedAnchor write for the round key, with the key that sent it (spec "Stolen anchor key"). */
export interface AnchorWrite {
  event: 'Locked' | 'Committed' | 'ManifestAnchored';
  txHash: Hex;
  blockNumber: bigint;
  sender: Hex;
  /** The block of a later `RoleRevoked(ANCHOR_ROLE, sender)`, or null. */
  revokedAtBlock: bigint | null;
  /** The sender's ANCHOR_ROLE was revoked after this write. */
  disputed: boolean;
}

/** The Stakes proposal the bundle was compared with (the `OutcomeProposed` log whose bundleHash matched). */
export interface ProposalInfo {
  status: 'SettleProposed' | 'RefundProposed';
  n0: number;
  n1: number;
  nVoid: number;
  payoutRoot: Hex;
  bundleHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  /** The round's status on chain now (e.g. Settled, or Refunded after a veto). */
  onchainStatus: string;
}

export interface Report {
  roundId: string;
  mode: Mode;
  chainId: number;
  verdict: Verdict;
  exitCode: 0 | 1 | 2;
  /** Some anchor came from a key whose ANCHOR_ROLE was later revoked. */
  disputed: boolean;
  /** keccak256(manifest bytes), when the manifest was fetched. */
  bundleHash: Hex | null;
  /** The recomputed settlement record, when it could be recomputed. */
  record: SettlementRecord | null;
  entryCount: number | null;
  anchors: AnchorWrite[];
  proposal: ProposalInfo | null;
  checks: Check[];
}

/** Reads bundle objects by their R2 key (`bundles/{roundId}/{mode}/…`). null when the object is absent. */
export type BundleSource = (key: string) => Promise<Uint8Array | null>;

export interface VerifyRoundOptions {
  rpcUrl: string;
  chainId: number;
  /** The round's ULID. */
  roundId: string;
  mode: Mode;
  /** The Flocked API origin, which serves bundle objects at `/rounds/:id/bundles/:mode/:file` (see `httpSource`). */
  bundleBaseUrl: string;
  /** The drand chain the picks target; default quicknet. */
  drand?: DrandChain;
  /** Escrow and anchor addresses; default the committed deployment for `chainId`. */
  addresses?: { escrow: Hex; anchor: Hex; deployBlock: bigint };
  /** Overrides how bundle objects are read (tests, local directories); default `fetch`. */
  source?: BundleSource;
  /** Overrides the chain reads (tests); default a viem client on `rpcUrl`. */
  reader?: ChainReader;
  /** Progress lines (the CLI prints them to stderr). */
  onProgress?: (line: string) => void;
}
