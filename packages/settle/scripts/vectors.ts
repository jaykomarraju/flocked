/**
 * Deterministic settlement vector generator (pure: no I/O). `gen-vectors.ts` writes the result to vectors/.
 * Every numeric field is a decimal string (P1.1). A fixed seed drives the random cases.
 */
import { bytesToHex, hexToBytes, keccak256, toHex } from 'viem';
import type { EntryInput, OptionIndex, Payout, SettleParams, StakesClosedForm } from '../src/index.js';
import {
  FORMULA_VERSION,
  VOID_REASONS,
  checkInvariant,
  freePayoutTree,
  settle,
  settleStakesClosedForm,
  stakesPayoutTree,
  userIdHash,
} from '../src/index.js';

export const SEED = 0x5e771e;
const USDC = 1_000_000n;
const STAKES: SettleParams = { feeBps: 500, creatorBps: 100, capMultiple: 10, minEntrants: 20 };
const FREE: SettleParams = { feeBps: 0, creatorBps: 0, capMultiple: 10, minEntrants: 1, creatorAwardBps: 100 };
/** Largest round the generator cross-checks against the general formula entry by entry. */
const CROSS_CHECK_MAX_ENTRIES = 300_000n;

/** mulberry32: small, fast, deterministic across platforms. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const big = (min: bigint, max: bigint): bigint => {
    let v = 0n;
    for (let i = 0; i < 4; i++) v = (v << 32n) | BigInt(int(0, 0xffffffff));
    return min + (v % (max - min + 1n));
  };
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  return { next, int, big, pick };
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const str = (v: bigint | number): string => v.toString();
const byId = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function stakesEntries(stake: bigint, n0: bigint, n1: bigint, nVoid: bigint): EntryInput[] {
  const out: EntryInput[] = [];
  let i = 0;
  const account = () => `0x${(++i).toString(16).padStart(40, '0')}`;
  for (let k = 0n; k < n0; k++) out.push({ account: account(), stake, option: 0, voidReason: null });
  for (let k = 0n; k < n1; k++) out.push({ account: account(), stake, option: 1, voidReason: null });
  for (let k = 0n; k < nVoid; k++) out.push({ account: account(), stake, option: null, voidReason: 'decrypt_failed' });
  return out;
}

/** Throws unless the closed form agrees with the general formula (record and every entry's payout). */
function crossCheck(stake: bigint, n0: bigint, n1: bigint, nVoid: bigint, params: SettleParams, cf: StakesClosedForm): void {
  if (n0 + n1 + nVoid > CROSS_CHECK_MAX_ENTRIES) return;
  const entries = stakesEntries(stake, n0, n1, nVoid);
  const { record, payouts } = settle(entries, params);
  checkInvariant(record, payouts);
  const paid = new Map<string, bigint>(payouts.map((p) => [p.account, p.amount]));
  const fail = (what: string) => {
    throw new Error(`closed form != general formula (${what}) for s=${stake} n0=${n0} n1=${n1} nVoid=${nVoid}`);
  };
  for (const k of ['lossPool', 'fee', 'creatorFee', 'distributable', 'rebatePool', 'dust'] as const) {
    if (record[k] !== cf[k]) fail(k);
  }
  if (record.refundReason !== cf.refundReason || record.winner !== cf.winner) fail('outcome');
  for (const e of entries) {
    const want =
      cf.outcome === 'refunded' || e.option === null ? cf.voidRefund : e.option === cf.winner ? cf.winPayout : cf.rebatePayout;
    if ((paid.get(e.account) ?? 0n) !== want) fail(`payout of ${e.account}`);
  }
}

interface ClosedCase {
  id: string;
  stake: bigint;
  n0: bigint;
  n1: bigint;
  nVoid: bigint;
  params?: Partial<SettleParams>;
}

function closedFormCases(): ClosedCase[] {
  const s5 = 5n * USDC;
  const s100 = 100n * USDC;
  const cases: ClosedCase[] = [
    { id: 'settle-basic', stake: s5, n0: 30n, n1: 12n, nVoid: 1n },
    { id: 'refund-1-min-minus-one', stake: s5, n0: 7n, n1: 12n, nVoid: 0n },
    { id: 'refund-1-voids-do-not-count', stake: s5, n0: 7n, n1: 12n, nVoid: 5n },
    { id: 'refund-1-empty', stake: s5, n0: 0n, n1: 0n, nVoid: 0n },
    { id: 'refund-1-only-voids', stake: s5, n0: 0n, n1: 0n, nVoid: 25n },
    { id: 'refund-1-precedes-one-sided', stake: s5, n0: 10n, n1: 0n, nVoid: 0n },
    { id: 'min-entrants-exact', stake: s5, n0: 8n, n1: 12n, nVoid: 0n },
    { id: 'refund-2-one-sided-option-1', stake: s5, n0: 0n, n1: 25n, nVoid: 0n },
    { id: 'refund-2-one-sided-option-0', stake: s5, n0: 25n, n1: 0n, nVoid: 3n },
    { id: 'refund-2-min-entrants-0-empty', stake: s5, n0: 0n, n1: 0n, nVoid: 2n, params: { minEntrants: 0 } },
    { id: 'refund-3-tie', stake: s5, n0: 15n, n1: 15n, nVoid: 1n },
    { id: 'refund-3-tie-large', stake: s100, n0: 100_000n, n1: 100_000n, nVoid: 7n },
    { id: 'tie-broken-by-one', stake: s5, n0: 15n, n1: 16n, nVoid: 0n },
    { id: 'cap-binding-1-vs-20', stake: USDC, n0: 1n, n1: 20n, nVoid: 0n },
    { id: 'cap-boundary-ratio-10-not-binding', stake: USDC, n0: 2n, n1: 20n, nVoid: 0n },
    { id: 'cap-boundary-ratio-11-binding', stake: USDC, n0: 2n, n1: 22n, nVoid: 1n },
    { id: 'cap-not-binding-r-zero', stake: s5, n0: 40n, n1: 60n, nVoid: 0n },
    { id: 'cap-multiple-1-binding', stake: 2n * USDC, n0: 5n, n1: 15n, nVoid: 0n, params: { capMultiple: 1 } },
    { id: 'cap-multiple-1-not-binding', stake: 2n * USDC, n0: 100n, n1: 106n, nVoid: 0n, params: { capMultiple: 1 } },
    { id: 'cap-multiple-10-heavy', stake: s5, n0: 3n, n1: 300n, nVoid: 4n },
    { id: 'rebate-positive-with-dust', stake: 3n * USDC, n0: 7n, n1: 93n, nVoid: 0n },
    { id: 'stake-1-base-unit', stake: 1n, n0: 21n, n1: 30n, nVoid: 0n },
    { id: 'stake-1-base-unit-cap', stake: 1n, n0: 1n, n1: 20n, nVoid: 2n },
    { id: 'stake-1-base-unit-large', stake: 1n, n0: 100_000n, n1: 150_000n, nVoid: 3n },
    { id: 'stake-100-usdc', stake: s100, n0: 30n, n1: 70n, nVoid: 0n },
    { id: 'stake-100-usdc-voids', stake: s100, n0: 30n, n1: 70n, nVoid: 9n },
    { id: 'large-100k-vs-150k', stake: s100, n0: 100_000n, n1: 150_000n, nVoid: 1_000n },
    { id: 'large-100k-vs-1m-ratio-10', stake: s100, n0: 100_000n, n1: 1_000_000n, nVoid: 0n },
    { id: 'large-100k-vs-1.1m-cap-binding', stake: s100, n0: 100_000n, n1: 1_100_000n, nVoid: 12n },
    { id: 'large-billions', stake: s100, n0: 1_000_000_000n, n1: 3_000_000_007n, nVoid: 12_345n },
    { id: 'fees-min-zero', stake: s5, n0: 9n, n1: 13n, nVoid: 0n, params: { feeBps: 0, creatorBps: 0 } },
    { id: 'fees-min-zero-cap-binding', stake: s5, n0: 1n, n1: 30n, nVoid: 1n, params: { feeBps: 0, creatorBps: 0 } },
    { id: 'fees-max-fee-only', stake: s5, n0: 9n, n1: 13n, nVoid: 0n, params: { feeBps: 10_000, creatorBps: 0 } },
    { id: 'fees-max-creator-only', stake: s5, n0: 9n, n1: 13n, nVoid: 0n, params: { feeBps: 0, creatorBps: 10_000 } },
    { id: 'fees-max-split', stake: s5, n0: 9n, n1: 13n, nVoid: 2n, params: { feeBps: 9_000, creatorBps: 1_000 } },
    { id: 'fees-odd-bps-rounding', stake: 333_333n, n0: 11n, n1: 17n, nVoid: 0n, params: { feeBps: 333, creatorBps: 77 } },
    { id: 'min-entrants-1', stake: s5, n0: 1n, n1: 2n, nVoid: 0n, params: { minEntrants: 1 } },
    { id: 'min-entrants-3-room-boundary', stake: s5, n0: 1n, n1: 1n, nVoid: 4n, params: { minEntrants: 3 } },
    { id: 'min-entrants-3-room-settles', stake: s5, n0: 1n, n1: 2n, nVoid: 0n, params: { minEntrants: 3 } },
  ];
  const r = rng(SEED);
  const stakes = [1n, 7n, USDC, s5, 10n * USDC, 25n * USDC, s100];
  for (let k = 0; k < 24; k++) {
    const feeBps = r.pick([0, 100, 500, 500, 500, 1000, r.int(0, 10_000)]);
    const creatorBps = Math.min(r.pick([0, 100, 100, 250, r.int(0, 10_000)]), 10_000 - feeBps);
    const n0 = BigInt(r.int(0, 400));
    const n1 = BigInt(r.pick([r.int(0, 400), r.int(0, 5000)]));
    cases.push({
      id: `random-${String(k).padStart(2, '0')}`,
      stake: r.pick([r.pick(stakes), r.big(1n, s100)]),
      n0,
      n1,
      nVoid: BigInt(r.pick([0, 0, r.int(1, 20)])),
      params: { feeBps, creatorBps, capMultiple: r.pick([1, 2, 5, 10, 10, 10]), minEntrants: r.pick([1, 3, 20, 20, 50]) },
    });
  }
  return cases;
}

function stakesClosedFormFile(): unknown {
  const vectors = closedFormCases().map((c) => {
    const params: SettleParams = { ...STAKES, ...c.params };
    const cf = settleStakesClosedForm({ stake: c.stake, n0: c.n0, n1: c.n1, nVoid: c.nVoid, ...params });
    crossCheck(c.stake, c.n0, c.n1, c.nVoid, params, cf);
    return {
      id: c.id,
      stake: str(c.stake),
      feeBps: str(params.feeBps),
      creatorBps: str(params.creatorBps),
      capMultiple: str(params.capMultiple),
      minEntrants: str(params.minEntrants),
      n0: str(c.n0),
      n1: str(c.n1),
      nVoid: str(c.nVoid),
      expected: {
        status: cf.outcome === 'settled' ? '2' : '3',
        refundReason: str(cf.refundReason ?? 0),
        winner: str(cf.winner ?? 255),
        lossPool: str(cf.lossPool),
        fee: str(cf.fee),
        creatorFee: str(cf.creatorFee),
        distributable: str(cf.distributable),
        w: str(cf.w),
        rebatePool: str(cf.rebatePool),
        r: str(cf.r),
        dust: str(cf.dust),
        winPayout: str(cf.winPayout),
        rebatePayout: str(cf.rebatePayout),
        voidRefund: str(cf.voidRefund),
        roundBalance: str(cf.roundBalance),
      },
    };
  });
  return { formulaVersion: str(FORMULA_VERSION), kind: 'stakes-closed-form', vectors: byId(vectors) };
}

/** Deterministic pseudo-random lowercase address. */
function address(tag: string, i: number): `0x${string}` {
  return `0x${keccak256(toHex(`${tag}:${i}`)).slice(26)}`;
}

const LEAF_KIND: Record<Payout['kind'], 0 | 1 | 2 | null> = { win: 0, rebate: 1, void_refund: 2, refund: null };

function merkleVector(id: string, chainRoundId: bigint, leaves: { account: `0x${string}`; kind: 0 | 1 | 2 }[], sample: number[]) {
  const sorted = [...leaves].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : a.kind - b.kind));
  const tree = stakesPayoutTree(chainRoundId, sorted);
  return {
    id,
    chainRoundId: str(chainRoundId),
    leaves: sorted.map((l) => ({ account: l.account, kind: str(l.kind) })),
    root: tree.root,
    proofs: sample.map((i) => {
      const l = sorted[i];
      if (!l) throw new Error(`sample index ${i} out of range`);
      return { account: l.account, kind: str(l.kind), proof: tree.proof(l.account, l.kind) };
    }),
  };
}

/** Leaves of a real settled round: win, rebate (r > 0) and VOID refunds. */
function settledLeaves(tag: string, stake: bigint, n0: number, n1: number, nVoid: number) {
  const entries: EntryInput[] = [];
  let i = 0;
  const push = (option: OptionIndex | null) => {
    entries.push({ account: address(tag, i++), stake, option, voidReason: option === null ? 'bad_plaintext' : null });
  };
  for (let k = 0; k < n0; k++) push(0);
  for (let k = 0; k < n1; k++) push(1);
  for (let k = 0; k < nVoid; k++) push(null);
  const { record, payouts } = settle(entries, STAKES);
  checkInvariant(record, payouts);
  return payouts.map((p) => {
    const kind = LEAF_KIND[p.kind];
    if (kind === null) throw new Error('expected a settled round');
    return { account: p.account as `0x${string}`, kind };
  });
}

function stakesPayoutMerkleFile(): unknown {
  const r = rng(SEED + 1);
  const large = settledLeaves('large', USDC, 100, 1100, 3);
  const sample = [0, large.length - 1];
  while (sample.length < 32) {
    const i = r.int(1, large.length - 2);
    if (!sample.includes(i)) sample.push(i);
  }
  sample.sort((a, b) => a - b);
  const all = (n: number) => Array.from({ length: n }, (_, i) => i);
  const vectors = [
    merkleVector('one-leaf', 7n, [{ account: address('one', 0), kind: 0 }], [0]),
    merkleVector('two-leaf', 8n, [{ account: address('two', 0), kind: 0 }, { account: address('two', 1), kind: 2 }], all(2)),
    merkleVector('odd-seven-leaf', 9n, settledLeaves('odd', 5n * USDC, 1, 30, 0).slice(0, 7), all(7)),
    merkleVector('small-settled', 10n, settledLeaves('small', 5n * USDC, 2, 22, 1), all(25)),
    merkleVector('large-1203-leaf', (1n << 128n) + 5n, large, sample),
  ];
  return { kind: 'stakes-payout-merkle', vectors: byId(vectors) };
}

interface FreeCase {
  id: string;
  params?: Partial<SettleParams>;
  /** [option or void reason, stake, qualifies?] per entrant. */
  entries: [OptionIndex | (typeof VOID_REASONS)[number], bigint, boolean?][];
}

function freeCases(): FreeCase[] {
  const room: Partial<SettleParams> = { minEntrants: 3, countQualifyingOnly: true, creatorAwardBps: 0 };
  const cases: FreeCase[] = [
    { id: 'minority-holds-more-stake', entries: [[0, 1000n], [0, 500n], [1, 1000n], [1, 1000n], [1, 1000n], [1, 1000n], [1, 1000n]] },
    { id: 'cap-binding-uneven-stakes', entries: [[0, 1n], [0, 1n], [1, 100n], [1, 50n], [1, 30n]] },
    { id: 'cap-binding-single-whale-loser', entries: [[0, 10n], [1, 1_000_000n], [1, 1n]] },
    { id: 'all-void-reasons', entries: [[0, 70n], [1, 20n], [1, 30n], ...VOID_REASONS.map((v, i): [typeof v, bigint] => [v, BigInt(100 + i)])] },
    { id: 'refund-1-empty', entries: [] },
    { id: 'refund-1-only-voids', entries: [['not_anchored', 40n], ['stake_out_of_range', 99_999n]] },
    { id: 'refund-2-one-sided', entries: [[1, 10n], [1, 99n], ['bad_option', 5n]] },
    { id: 'refund-3-tie-uneven-stakes', entries: [[0, 1000n], [0, 1n], [1, 5n], [1, 5n]] },
    { id: 'room-refund-1-two-qualifying', params: room, entries: [[0, 10n, true], [1, 10n, true], [1, 10n, false], [1, 10n, false]] },
    { id: 'room-settles-three-qualifying', params: room, entries: [[0, 10n, true], [1, 10n, true], [1, 10n, true], ['wrong_target', 10n, true]] },
    { id: 'single-unit-stakes', entries: [[0, 1n], [1, 1n], [1, 1n]] },
    { id: 'huge-stakes', entries: [[0, 10n ** 30n], [1, 3n * 10n ** 30n + 7n], [1, 10n ** 29n]] },
    { id: 'general-with-fees', params: { feeBps: 500, creatorBps: 100, minEntrants: 1 }, entries: [[0, 300n], [0, 700n], [1, 5000n], [1, 2500n], [1, 1234n]] },
  ];
  const r = rng(SEED + 2);
  for (let k = 0; k < 16; k++) {
    const count = r.int(1, 40);
    const entries: FreeCase['entries'] = [];
    const skew = r.next();
    for (let j = 0; j < count; j++) {
      const stake = r.pick([r.big(1n, 100n), r.big(1n, 100_000n), r.big(1n, 10n ** 12n)]);
      entries.push(r.next() < 0.08 ? [r.pick(VOID_REASONS), stake] : [r.next() < skew ? 0 : 1, stake, r.next() < 0.8]);
    }
    cases.push({
      id: `random-${String(k).padStart(2, '0')}`,
      params: { creatorAwardBps: r.pick([0, 100, 100, 250]), capMultiple: r.pick([1, 3, 10, 10]), minEntrants: r.pick([1, 1, 5]) },
      entries,
    });
  }
  return cases;
}

function freeGeneralFile(): unknown {
  const vectors = freeCases().map((c, caseIndex) => {
    const roundId = hexToBytes(keccak256(toHex(`free-round:${c.id}`))).slice(0, 16);
    const params: SettleParams = { ...FREE, ...c.params };
    const entries: EntryInput[] = c.entries.map(([kind, stake, qualifies], j) => {
      const userId = hexToBytes(keccak256(toHex(`user:${caseIndex}:${j}`))).slice(0, 16);
      const account = userIdHash(roundId, userId);
      const base = typeof kind === 'number' ? { option: kind, voidReason: null } : { option: null, voidReason: kind };
      return { account, stake, ...base, ...(qualifies === undefined ? {} : { qualifies }) };
    });
    entries.sort((a, b) => (a.account < b.account ? -1 : 1));
    const { record, payouts } = settle(entries, params);
    checkInvariant(record, payouts);
    const payoutRoot =
      payouts.length === 0
        ? null
        : freePayoutTree(roundId, payouts.map((p) => ({ userIdHash: p.account as `0x${string}`, amount: p.amount }))).root;
    return {
      id: c.id,
      roundId: bytesToHex(roundId),
      params: {
        feeBps: str(params.feeBps),
        creatorBps: str(params.creatorBps),
        capMultiple: str(params.capMultiple),
        minEntrants: str(params.minEntrants),
        creatorAwardBps: str(params.creatorAwardBps ?? 0),
        countQualifyingOnly: params.countQualifyingOnly ?? false,
      },
      entries: entries.map((e) => ({
        account: e.account,
        stake: str(e.stake),
        option: e.option === null ? null : str(e.option),
        voidReason: e.voidReason,
        ...(e.qualifies === undefined ? {} : { qualifies: e.qualifies }),
      })),
      expected: {
        record: {
          outcome: record.outcome,
          refundReason: record.refundReason === null ? null : str(record.refundReason),
          n: record.n.map(str),
          w: record.w.map(str),
          winner: record.winner === null ? null : str(record.winner),
          lossPool: str(record.lossPool),
          fee: str(record.fee),
          creatorFee: str(record.creatorFee),
          distributable: str(record.distributable),
          rebatePool: str(record.rebatePool),
          dust: str(record.dust),
          voidCount: str(record.voidCount),
          voidStake: str(record.voidStake),
          total: str(record.total),
          creatorAward: str(record.creatorAward),
        },
        payouts: payouts.map((p) => ({ account: p.account, kind: p.kind, amount: str(p.amount) })),
        payoutRoot,
      },
    };
  });
  return { formulaVersion: str(FORMULA_VERSION), kind: 'free-general', vectors: byId(vectors) };
}

/** File name → exact file contents. */
export function generateVectors(): Record<string, string> {
  return {
    'stakes-closed-form.json': json(stakesClosedFormFile()),
    'stakes-payout-merkle.json': json(stakesPayoutMerkleFile()),
    'free-general.json': json(freeGeneralFile()),
  };
}
