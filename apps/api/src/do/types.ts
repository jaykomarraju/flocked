// Pinned Durable Object RPC contracts (plan P2.4). Wave 3+ sessions implement the classes in
// src/do/*.ts against these interfaces; changing a method name or shape is a D/Z decision.
//
// Conventions: IDs are ULIDs; hashes, keys and addresses are lowercase 0x hex; money is a decimal
// string of base units (points or USDC), as on the wire; times named `*At` are epoch ms, while
// beacon math (`closesAtSec`, `beaconTimeSec`, onchain values) is Unix seconds. Methods report
// expected rejections as values (`RpcResult`), because only an Error's message survives DO RPC.
import type {
  CreateEntryRequest,
  CreateEntryResponse,
  ErrorCode,
  LockedConfig,
  Mode,
  ModeStatus,
  OptionTally,
  RefundReason,
  RoundKind,
  RoundStatus,
  VoidReason,
  WsServerMessage,
  WsStateMessage,
} from '@flocked/shared';
import type { OptionIndex } from '@flocked/settle';
import type { Hex } from 'viem';

/** An expected outcome or a typed rejection (the route maps `code` to its HTTP status). */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

/** Decimal string of base units. */
export type Amount = string;

// RoundDO (spec "Real-time and the reveal" › RoundDO responsibilities) -----------------------------

/** `init(locked)`: everything frozen at question lock, loaded into the round's DO. */
export interface LockedRound {
  roundId: string;
  kind: RoundKind;
  roomId: string | null;
  questionId: string;
  opensAt: number;
  closesAt: number;
  beaconRound: number;
  /** genesis + (beaconRound − 1) × period, Unix seconds. */
  beaconTimeSec: number;
  config: LockedConfig;
  /** Modes with a `round_modes` row (enabled at lock). */
  modes: Mode[];
  /** Stakes: FlockedEscrow round ID (uint256 decimal). */
  chainRoundId?: string;
}

/** `enterFree(req)`: the authenticated user and the validated POST /rounds/:id/entries body. */
export interface EnterFreeRequest {
  roundId: string;
  userId: string;
  body: CreateEntryRequest;
}
export type EnterFreeResponse = CreateEntryResponse;

export interface ModeLiveState {
  status: ModeStatus;
  entrantCount: number;
  pool: Amount;
}

/** `getState()`: the DO's snapshot (no per-option data before that mode's reveal). */
export interface RoundState {
  roundId: string;
  status: RoundStatus;
  /** True once a void was requested; entries stop at that moment. */
  voidRequested: boolean;
  opensAt: number;
  closesAt: number;
  beaconRound: number;
  beaconTimeSec: number;
  modes: Partial<Record<Mode, ModeLiveState>>;
}

/** `ingestStakesEntry(evt)`: one mirrored `Entered` event (spec "Smart contract" FlockedEscrow). */
export interface StakesEntryEvent {
  roundId: string;
  chainRoundId: string;
  player: Hex;
  personTag: Hex;
  ticketHash: Hex;
  /** The fixed round stake (USDC base units). */
  stake: Amount;
  /** keccak256(ciphertext); the ciphertext itself stays in chain data. */
  commitment: Hex;
  /** `stakes_tickets.user_id` for the ticket; null if no ticket matches (signer-compromise path). */
  userId: string | null;
  txHash: Hex;
  blockNumber: number;
  logIndex: number;
  blockTimestampSec: number;
}

export interface StakesIngestResult {
  /** False when (txHash, logIndex) was already counted (idempotent replay, reorg re-index). */
  counted: boolean;
  entrantCount: number;
  pool: Amount;
}

/** Per-option valid headcount and stake total, option 0 then option 1 (as in the WS `revealed`). */
export type ModeTally = [OptionTally, OptionTally];

/** `onModeResult(mode, result)`: what the settlement coordinator hands back for broadcast. */
export type ModeResult =
  | {
      outcome: 'revealed';
      winningOption: OptionIndex;
      tally: ModeTally;
      bundleHash: Hex;
      revealedAt: number;
      /** Stakes: from the confirmed onchain proposal ("Final at"). */
      claimsOpenAt?: number;
    }
  | {
      outcome: 'refunded';
      reason: RefundReason;
      /** Stakes refund proposals are provisional until claimsOpenAt. */
      provisional: boolean;
      claimsOpenAt?: number;
      bundleHash?: Hex;
    };

export interface VoidRequestResult {
  /** False once closesAt has passed: a void is only possible before close (spec "Void"). */
  accepted: boolean;
  stoppedAt: number;
}

export interface RoundDORpc {
  init(locked: LockedRound): Promise<RoundState>;
  enterFree(req: EnterFreeRequest): Promise<RpcResult<EnterFreeResponse>>;
  getState(): Promise<RoundState>;
  ingestStakesEntry(evt: StakesEntryEvent): Promise<StakesIngestResult>;
  onModeResult(mode: Mode, result: ModeResult): Promise<void>;
  requestVoid(): Promise<VoidRequestResult>;
}

// RoundViewerDO (spec "Non-functional requirements" › Scaling notes: WebSocket fan-out) ----------

/** Binds a viewer shard to its round; client WebSockets then arrive through the shard's `fetch`. */
export interface ViewerSubscription {
  roundId: string;
  /** 0 ≤ shard < shardCount (N = 16 by default). */
  shard: number;
  shardCount: number;
  /** Room rounds: only members may connect. */
  membersOnly: boolean;
}

export interface RoundViewerDORpc {
  /** Returns the `state` message new connections receive first. */
  subscribe(sub: ViewerSubscription): Promise<WsStateMessage>;
  /** Relays one message to every connected client; returns how many sockets it reached. */
  broadcast(message: WsServerMessage): Promise<{ delivered: number }>;
}

// AnchorDO (spec "Architecture" AnchorDO; "Smart contract" › Contract: FlockedAnchor) -------------

/** roundKey = keccak256(abi.encode(roundId, mode)). */
export interface AnchorKey {
  roundKey: Hex;
  roundId: string;
  mode: Mode;
}

/** One `lock` item (Free lock leaf, at question lock). */
export interface AnchorLockItem extends AnchorKey {
  closesAtSec: number;
  beaconRound: number;
  questionHash: Hex;
  configHash: Hex;
}

/** The Free commitment root, posted before min(close + 90 s, beaconTime − 30 s). */
export interface AnchorCommitItem extends AnchorKey {
  root: Hex;
  entryCount: number;
  /** uint64 total stake. */
  totalStake: Amount;
  closesAtSec: number;
  beaconRound: number;
  beaconTimeSec: number;
}

/** `anchorManifest`, write-once and only after beacon time. */
export interface AnchorManifestItem extends AnchorKey {
  manifestHash: Hex;
  beaconTimeSec: number;
}

export type AnchorItemState = 'none' | 'queued' | 'sent' | 'confirmed' | 'skipped' | 'failed';

export interface AnchorItemStatus {
  state: AnchorItemState;
  txHash?: Hex;
  /** Commit only: min(close + 90 s, beaconTime − 30 s), Unix seconds. */
  deadlineSec?: number;
  confirmedAt?: number;
  /** `Skipped(roundKey, reason)` reason or a local failure description. */
  detail?: string;
}

export interface AnchorSubmitAck {
  /** Keys accepted for (re)submission. */
  queued: Hex[];
  /** Keys already written onchain for this kind (write-once); nothing to do. */
  alreadyAnchored: Hex[];
}

export interface AnchorKeyStatus {
  roundKey: Hex;
  lock: AnchorItemStatus;
  commit: AnchorItemStatus;
  manifest: AnchorItemStatus;
}

export interface AnchorDORpc {
  submitLock(items: AnchorLockItem[]): Promise<AnchorSubmitAck>;
  submitCommit(item: AnchorCommitItem): Promise<AnchorSubmitAck>;
  submitManifest(item: AnchorManifestItem): Promise<AnchorSubmitAck>;
  status(roundKey: Hex): Promise<AnchorKeyStatus>;
}

// SettlementDO (spec "Architecture": one per (round, mode); tracks decrypt chunks, idempotent) ----

/** The `settle` queue message's key: idempotency key = `${roundId}:${mode}`. */
export interface SettlementKey {
  roundId: string;
  mode: Mode;
  idempotencyKey: string;
}

/** One decrypted chunk's partial tally (about 500 ciphertexts; outputs in R2 at `resultKey`). */
export interface DecryptChunkResult {
  entries: number;
  valid: number;
  /** Partial tally over this chunk's valid entries. */
  tally: ModeTally;
  voids: Partial<Record<VoidReason, number>>;
  /** R2 key of the chunk's per-entry results (option, nonce, validity, VOID reason). */
  resultKey: string;
}

export type SettlementPhase =
  'idle' | 'preparing' | 'decrypting' | 'reducing' | 'proposing' | 'applying' | 'done' | 'failed';

export interface SettlementStatus {
  roundId: string | null;
  mode: Mode | null;
  phase: SettlementPhase;
  chunksTotal: number;
  chunksDone: number;
  startedAt: number | null;
  updatedAt: number | null;
  error: string | null;
}

export interface SettlementDORpc {
  /** Idempotent: a second start for the same key returns `started: false`. */
  start(key: SettlementKey): Promise<{ started: boolean; status: SettlementStatus }>;
  /** Idempotent per chunk key; the last chunk triggers the reduce step. */
  chunkDone(chunkKey: string, result: DecryptChunkResult): Promise<SettlementStatus>;
  status(): Promise<SettlementStatus>;
}

// AuthDO (spec "Data model": SIWE nonces and email codes in KV, hashed, 5-minute TTL; AuthDO
// consumes each atomically and counts attempts; "Identity and personhood": OAuth state) ----------

export type ConsumeFailure = 'unknown' | 'expired' | 'used';

export type ConsumeResult = { ok: true } | { ok: false; reason: ConsumeFailure };

export interface EmailCodeAttempt {
  /** Hash of the normalised email address. */
  emailHash: string;
  /** Hash of the submitted 8-digit code. */
  codeHash: string;
}

export type EmailCodeResult =
  | { ok: true }
  | {
      ok: false;
      reason: ConsumeFailure | 'wrong_code' | 'too_many_attempts';
      /** Of 5 per code (spec "API" › Rate limits). */
      attemptsLeft: number;
    };

/** Coinbase OAuth state, single-use and bound to the user who started the flow. */
export interface OAuthStateBinding {
  stateHash: string;
  userId: string;
  /** PKCE verifier, kept only until the callback. */
  codeVerifier: string;
  expiresAt: number;
}

export type OAuthStateResult =
  { ok: true; userId: string; codeVerifier: string } | { ok: false; reason: ConsumeFailure };

export interface AuthDORpc {
  consumeNonce(nonceHash: string): Promise<ConsumeResult>;
  consumeEmailCode(attempt: EmailCodeAttempt): Promise<EmailCodeResult>;
  bindOAuthState(binding: OAuthStateBinding): Promise<void>;
  consumeOAuthState(stateHash: string): Promise<OAuthStateResult>;
}

// RateLimitDO (spec "API" › Rate limits: per-user and per-IP token buckets) -----------------------

/** A token bucket: `capacity` tokens, refilled continuously at capacity per `periodMs`. */
export interface RateLimitBucket {
  /** e.g. `user:<id>:entries`, `ip:<addr>:auth`. IPs live only for the window (spec "API"). */
  key: string;
  capacity: number;
  periodMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** 0 when allowed; otherwise ms until `cost` tokens are available. */
  retryAfterMs: number;
}

export interface RateLimitDORpc {
  take(bucket: RateLimitBucket, cost: number): Promise<RateLimitDecision>;
}

// IndexerDO (spec "Architecture": Chain indexer; "Data model" indexer_state) ---------------------

export interface IndexerPollResult {
  fromBlock: number;
  toBlock: number;
  events: number;
  /** True when the stored hash no longer matched and the indexer rewound 5 blocks. */
  reorg: boolean;
}

export interface IndexerContractStatus {
  contract: Hex;
  lastBlockNumber: number;
  lastBlockHash: Hex;
  updatedAt: number;
}

export interface IndexerStatus {
  chainId: number;
  contracts: IndexerContractStatus[];
  /** Seconds behind the chain head (alert over 150 s). */
  lagSec: number | null;
  /** Fast polling is active from closesAt − 5 min until proposals confirm. */
  fastPolling: boolean;
  nextAlarmAt: number | null;
}

export interface IndexerDORpc {
  poll(): Promise<IndexerPollResult>;
  status(): Promise<IndexerStatus>;
}
