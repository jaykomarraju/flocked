export const FORMULA_VERSION = 1;

export type OptionIndex = 0 | 1;
export type Mode = 'free' | 'stakes';

export const VOID_REASONS = [
  'decrypt_failed',
  'non_canonical_header',
  'wrong_target',
  'bad_plaintext',
  'bad_option',
  'not_anchored',
  'stake_out_of_range',
] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

/** Spec refund codes. `settle` itself decides only 1–3; 4–8 are lifecycle outcomes decided elsewhere. */
export type RefundReason = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Round parameters. `number` is allowed here only for bps, the cap multiple and counts, never for money. */
export interface SettleParams {
  feeBps: number;
  creatorBps: number;
  capMultiple: number;
  minEntrants: number;
  /** Free only; default 0. The house-minted creator award, outside the invariant. */
  creatorAwardBps?: number;
  /** Room rounds: `minEntrants` counts only valid entries with `qualifies = true`. */
  countQualifyingOnly?: boolean;
}

export interface EntryInput {
  /** Stakes: lowercase address. Free: hex userIdHash (bytes32). */
  account: string;
  stake: bigint;
  /** null when VOID. */
  option: OptionIndex | null;
  /** null when valid. */
  voidReason: VoidReason | null;
  /** Room-minimum qualification. */
  qualifies?: boolean;
}

export interface SettlementRecord {
  outcome: 'settled' | 'refunded';
  refundReason: 1 | 2 | 3 | null;
  /** Headcount per option, valid entries only. */
  n: [bigint, bigint];
  /** Stake per option, valid entries only. */
  w: [bigint, bigint];
  winner: OptionIndex | null;
  lossPool: bigint;
  fee: bigint;
  creatorFee: bigint;
  distributable: bigint;
  rebatePool: bigint;
  dust: bigint;
  voidCount: bigint;
  voidStake: bigint;
  /** T: sum of valid stakes. */
  total: bigint;
  /** Free only, outside the invariant. */
  creatorAward: bigint;
}

export type PayoutKind = 'win' | 'rebate' | 'void_refund' | 'refund';

export interface Payout {
  account: string;
  kind: PayoutKind;
  amount: bigint;
}

export interface SettleResult {
  record: SettlementRecord;
  payouts: Payout[];
}

/** Stakes closed-form result: the per-entry amounts the contract derives from posted headcounts. */
export interface StakesClosedForm {
  outcome: 'settled' | 'refunded';
  refundReason: 1 | 2 | 3 | null;
  winner: OptionIndex | null;
  lossPool: bigint;
  fee: bigint;
  creatorFee: bigint;
  distributable: bigint;
  /** Winnings per winner (excluding the returned stake). */
  w: bigint;
  rebatePool: bigint;
  /** Rebate per loser. */
  r: bigint;
  dust: bigint;
  /** s + w, or 0 when refunded. */
  winPayout: bigint;
  /** r, or 0 when refunded. */
  rebatePayout: bigint;
  /** s: a VOID entry's refund (and every entry's refund when refunded). */
  voidRefund: bigint;
  /** (n0 + n1 + nVoid)·s. */
  roundBalance: bigint;
}
