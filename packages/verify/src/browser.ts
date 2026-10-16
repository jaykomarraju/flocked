// The browser-safe subset (the web Verify page, W11-C): no Node APIs. `test/browser.test.ts` bundles
// this entry for the browser platform and fails on any Node built-in.
export { verifyEntry, verifyRound } from './verify.js';
export type { EntryPayout, EntryReport } from './verify.js';
export { viemReader, ANCHOR_ROLE, ESCROW_STATUS } from './chain.js';
export type {
  AnchorLog,
  AnchorState,
  ChainReader,
  EnteredLog,
  ProposalLog,
  StakesRoundState,
} from './chain.js';
export { bundleUrl, httpSource, memorySource } from './source.js';
export type { HttpLayout } from './source.js';
export {
  checkBeacon,
  loadBundle,
  recomputeCommitment,
  recomputeEntries,
  recomputeSettlement,
  recordJson,
  settleParamsOf,
} from './recompute.js';
export type { LoadedBundle, Recomputed, RecomputedPick } from './recompute.js';
export { BUNDLE_FORMAT, chunkKey, manifestKey, parseCanonical } from './bundle.js';
export type { BundleEntry, Chunk, ChunkRef, Manifest, RecordJson } from './bundle.js';
export { Checks } from './checks.js';
export { EXIT_CODES } from './types.js';
export type {
  AnchorWrite,
  BundleSource,
  Check,
  CheckStatus,
  ProposalInfo,
  Report,
  Verdict,
  VerifyRoundOptions,
} from './types.js';
