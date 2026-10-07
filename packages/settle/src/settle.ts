import { BPS, toBigParams } from './params.js';
import { VOID_REASONS } from './types.js';
import type {
  EntryInput,
  OptionIndex,
  Payout,
  PayoutKind,
  SettleParams,
  SettleResult,
  SettlementRecord,
} from './types.js';

const KIND_ORDER: Record<PayoutKind, number> = { win: 0, rebate: 1, void_refund: 2, refund: 3 };

/** Payouts are sorted by account (ascending, lowercase hex compares as bytes), then kind. */
export function comparePayouts(a: Payout, b: Payout): number {
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}

/**
 * Refund rules 1–3, checked in spec order. `counted` is the headcount compared with `minEntrants`
 * (all valid entries, or only qualifying ones in room rounds).
 */
export function refundReasonFor(
  n0: bigint,
  n1: bigint,
  counted: bigint,
  minEntrants: bigint,
): 1 | 2 | 3 | null {
  if (counted < minEntrants) return 1;
  if (n0 === 0n || n1 === 0n) return 2;
  if (n0 === n1) return 3;
  return null;
}

function validateEntries(entries: readonly EntryInput[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.account.length === 0 || e.account !== e.account.toLowerCase()) {
      throw new TypeError(`account must be non-empty lowercase hex: ${e.account}`);
    }
    if (seen.has(e.account)) throw new TypeError(`duplicate account: ${e.account}`);
    seen.add(e.account);
    if (typeof e.stake !== 'bigint' || e.stake <= 0n) {
      throw new RangeError(`stake must be a positive bigint (${e.account})`);
    }
    if (e.voidReason === null) {
      if (e.option !== 0 && e.option !== 1)
        throw new TypeError(`valid entry needs option 0 or 1 (${e.account})`);
    } else {
      if (!VOID_REASONS.includes(e.voidReason))
        throw new TypeError(`unknown voidReason ${e.voidReason}`);
      if (e.option !== null) throw new TypeError(`VOID entry must have option null (${e.account})`);
    }
  }
}

/**
 * The general settlement formula (spec "Settlement and payout math"). Floors everywhere, bigint only.
 * VOID entries are excluded from tallies and refunded in full. A refunded round returns every stake as `refund`.
 */
export function settle(entries: readonly EntryInput[], params: SettleParams): SettleResult {
  const p = toBigParams(params);
  validateEntries(entries);

  const n: [bigint, bigint] = [0n, 0n];
  const w: [bigint, bigint] = [0n, 0n];
  let voidCount = 0n;
  let voidStake = 0n;
  let qualifying = 0n;
  for (const e of entries) {
    if (e.option === null) {
      voidCount += 1n;
      voidStake += e.stake;
      continue;
    }
    n[e.option] += 1n;
    w[e.option] += e.stake;
    if (e.qualifies === true) qualifying += 1n;
  }
  const total = w[0] + w[1];
  const counted = p.countQualifyingOnly ? qualifying : n[0] + n[1];

  const base: SettlementRecord = {
    outcome: 'refunded',
    refundReason: null,
    n,
    w,
    winner: null,
    lossPool: 0n,
    fee: 0n,
    creatorFee: 0n,
    distributable: 0n,
    rebatePool: 0n,
    dust: 0n,
    voidCount,
    voidStake,
    total,
    creatorAward: 0n,
  };

  const refundReason = refundReasonFor(n[0], n[1], counted, p.minEntrants);
  if (refundReason !== null) {
    const payouts: Payout[] = entries.map((e) => ({
      account: e.account,
      kind: 'refund',
      amount: e.stake,
    }));
    payouts.sort(comparePayouts);
    return { record: { ...base, refundReason }, payouts };
  }

  // M = the option with the smaller headcount; ties were refunded above.
  const winner: OptionIndex = n[0] < n[1] ? 0 : 1;
  const loser: OptionIndex = winner === 0 ? 1 : 0;
  const wM = w[winner];
  const lossPool = w[loser];
  const fee = (lossPool * p.feeBps) / BPS;
  const creatorFee = (lossPool * p.creatorBps) / BPS;
  const distributable = lossPool - fee - creatorFee;

  const payouts: Payout[] = [];
  let winnings = 0n;
  for (const e of entries) {
    if (e.option !== winner) continue;
    const share = (distributable * e.stake) / wM;
    const cap = p.capMultiple * e.stake;
    const wi = share < cap ? share : cap;
    winnings += wi;
    payouts.push({ account: e.account, kind: 'win', amount: e.stake + wi });
  }
  const rebatePool = distributable - winnings;
  let rebates = 0n;
  for (const e of entries) {
    if (e.option !== loser) continue;
    const rj = (rebatePool * e.stake) / lossPool;
    rebates += rj;
    // Zero rebates are omitted, matching the Stakes leaf rule ("Rebate leaves are omitted when r = 0").
    if (rj > 0n) payouts.push({ account: e.account, kind: 'rebate', amount: rj });
  }
  for (const e of entries) {
    if (e.option === null)
      payouts.push({ account: e.account, kind: 'void_refund', amount: e.stake });
  }
  payouts.sort(comparePayouts);

  const record: SettlementRecord = {
    ...base,
    outcome: 'settled',
    winner,
    lossPool,
    fee,
    creatorFee,
    distributable,
    rebatePool,
    dust: rebatePool - rebates,
    creatorAward: (lossPool * p.creatorAwardBps) / BPS,
  };
  return { record, payouts };
}
