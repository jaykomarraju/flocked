// Target-round vectors (TL-4). Each case states its expected client result by hand; the contract's
// expected result comes from an independent bigint model of FlockedEscrow.createRound's beacon rule.
// Deterministic: the output depends on nothing but this file.

interface Chain {
  genesis: bigint;
  period: bigint;
}
type Reason =
  | ''
  | 'invalid_round'
  | 'beacon_too_early'
  | 'beacon_too_late'
  | 'invalid_delay'
  | 'not_first_round'
  | 'beacon_in_past'
  | 'wrong_daily_close';

export interface TargetRoundVector {
  id: string;
  closesAt: string;
  beaconDelay: string;
  beaconRound: string;
  genesis: string;
  period: string;
  /** Unix seconds the client checks at. */
  now: string;
  /** YYYY-MM-DD for daily and room rounds (the 21:00 New York check), "" otherwise. */
  gameDay: string;
  expectedOk: boolean;
  /** The `TargetRoundError`, "" when ok. */
  reason: Reason;
  /** What `createRound` does with these beacon values: "" (accepts), "InvalidBeaconRound" or "BeaconOutOfRange". */
  contractError: '' | 'InvalidBeaconRound' | 'BeaconOutOfRange';
}

const QUICKNET: Chain = { genesis: 1692803367n, period: 3n };
/** A local-network-like chain with one-second rounds: every bound is reachable to the second. */
const ONE_SECOND: Chain = { genesis: 1700000000n, period: 1n };
/** A 30-second chain (drand's default network period): first-round rounding up to 29 s. */
const THIRTY_SECOND: Chain = { genesis: 1700000000n, period: 30n };

const time = (c: Chain, r: bigint): bigint => c.genesis + (r - 1n) * c.period;
const first = (c: Chain, t: bigint): bigint =>
  t <= c.genesis ? 1n : (t - c.genesis + c.period - 1n) / c.period + 1n;
/** A close time ≥ `near` whose offset from genesis is `k` mod period. */
function closeWithPhase(c: Chain, near: bigint, k: bigint): bigint {
  let t = near;
  while ((t - c.genesis) % c.period !== k) t += 1n;
  return t;
}

// 21:00 America/New_York closes, as UTC instants.
const NY = {
  '2026-10-08': BigInt(Date.UTC(2026, 9, 9, 1)) / 1000n, // EDT (UTC−4)
  '2026-12-01': BigInt(Date.UTC(2026, 11, 2, 2)) / 1000n, // EST (UTC−5)
  '2026-03-08': BigInt(Date.UTC(2026, 2, 9, 1)) / 1000n, // DST starts that morning: a 23 h day
  '2026-11-01': BigInt(Date.UTC(2026, 10, 2, 2)) / 1000n, // DST ends that morning: a 25 h day
};

function contractError(
  c: Chain,
  closesAt: bigint,
  round: bigint,
): TargetRoundVector['contractError'] {
  if (round === 0n) return 'InvalidBeaconRound';
  const bt = time(c, round);
  return bt < closesAt + 60n || bt > closesAt + 600n ? 'BeaconOutOfRange' : '';
}

export function generateVectors(): string {
  const cases: TargetRoundVector[] = [];
  const add = (
    id: string,
    c: Chain,
    closesAt: bigint,
    beaconDelay: bigint,
    beaconRound: bigint,
    reason: Reason,
    opts: { now?: bigint; gameDay?: string } = {},
  ): void => {
    cases.push({
      id,
      closesAt: String(closesAt),
      beaconDelay: String(beaconDelay),
      beaconRound: String(beaconRound),
      genesis: String(c.genesis),
      period: String(c.period),
      now: String(opts.now ?? closesAt - 3600n),
      gameDay: opts.gameDay ?? '',
      expectedOk: reason === '',
      reason,
      contractError: contractError(c, closesAt, beaconRound),
    });
  };

  const base = NY['2026-10-08'];
  const q0 = closeWithPhase(QUICKNET, base, 0n); // aligned: closesAt is a round time
  const q1 = closeWithPhase(QUICKNET, base, 1n);
  const q2 = closeWithPhase(QUICKNET, base, 2n);
  const Q = QUICKNET;

  // Default delay (120 s): aligned and both misaligned phases, and the neighbouring rounds.
  add('qn-delay120-aligned', Q, q0, 120n, first(Q, q0 + 120n), '');
  add('qn-delay120-phase1', Q, q1, 120n, first(Q, q1 + 120n), '');
  add('qn-delay120-phase2', Q, q2, 120n, first(Q, q2 + 120n), '');
  add('qn-delay120-next-round', Q, q0, 120n, first(Q, q0 + 120n) + 1n, 'not_first_round');
  add('qn-delay120-prev-round', Q, q0, 120n, first(Q, q0 + 120n) - 1n, 'not_first_round');

  // Lower bound: exactly closesAt + 60, one round early, and a misaligned close.
  add('qn-delay60-exact-min', Q, q0, 60n, first(Q, q0 + 60n), '');
  add('qn-delay60-prev-round-too-early', Q, q0, 60n, first(Q, q0 + 60n) - 1n, 'beacon_too_early');
  add('qn-delay60-phase1', Q, q1, 60n, first(Q, q1 + 60n), '');
  // Upper bound: exactly closesAt + 600; a misaligned close cannot meet 600 s; one round late.
  add('qn-delay600-exact-max', Q, q0, 600n, first(Q, q0 + 600n), '');
  add('qn-delay600-phase1-too-late', Q, q1, 600n, first(Q, q1 + 600n), 'beacon_too_late');
  add('qn-delay600-phase2-too-late', Q, q2, 600n, first(Q, q2 + 600n), 'beacon_too_late');
  add('qn-delay600-next-round-too-late', Q, q0, 600n, first(Q, q0 + 600n) + 1n, 'beacon_too_late');

  // Round 0: the contract reverts InvalidBeaconRound.
  add('qn-round0', Q, q0, 120n, 0n, 'invalid_round');

  // beaconDelay outside [60, 600] with a beacon the contract would accept.
  add('qn-delay59-in-bounds', Q, q2, 59n, first(Q, q2 + 59n), 'invalid_delay');
  add('qn-delay601-in-bounds', Q, q0, 601n, first(Q, q0 + 600n), 'invalid_delay');
  add('qn-delay0-in-bounds', Q, q0, 0n, first(Q, q0 + 60n), 'invalid_delay');

  // The beacon must still be in the future when the client checks.
  const r = first(Q, q0 + 120n);
  add('qn-now-at-beacon', Q, q0, 120n, r, 'beacon_in_past', { now: time(Q, r) });
  add('qn-now-after-beacon', Q, q0, 120n, r, 'beacon_in_past', { now: time(Q, r) + 1n });
  add('qn-now-one-second-before-beacon', Q, q0, 120n, r, '', { now: time(Q, r) - 1n });

  // Daily and room rounds close at 21:00 America/New_York on the game day, across DST.
  for (const [day, close] of Object.entries(NY)) {
    add(`qn-daily-${day}`, Q, close, 120n, first(Q, close + 120n), '', { gameDay: day });
  }
  add('qn-daily-one-second-late', Q, base + 1n, 120n, first(Q, base + 121n), 'wrong_daily_close', {
    gameDay: '2026-10-08',
  });
  add('qn-daily-wrong-day', Q, base, 120n, first(Q, base + 120n), 'wrong_daily_close', {
    gameDay: '2026-10-09',
  });
  const estAsEdt = NY['2026-12-01'] - 3600n; // 21:00 UTC−4 on an EST day is 20:00 local
  add(
    'qn-daily-edt-offset-in-winter',
    Q,
    estAsEdt,
    120n,
    first(Q, estAsEdt + 120n),
    'wrong_daily_close',
    {
      gameDay: '2026-12-01',
    },
  );

  // One-second rounds: every bound to the second.
  const S = ONE_SECOND;
  add('s1-min-exact', S, base, 60n, first(S, base + 60n), '');
  add('s1-min-minus-one', S, base, 60n, first(S, base + 59n), 'beacon_too_early');
  add('s1-max-exact', S, base, 600n, first(S, base + 600n), '');
  add('s1-max-plus-one', S, base, 600n, first(S, base + 601n), 'beacon_too_late');
  add('s1-delay61-off-by-one-round', S, base, 61n, first(S, base + 60n), 'not_first_round');
  add('s1-round0', S, base, 60n, 0n, 'invalid_round');
  // Round 1 when the close is before genesis.
  const preGenesis = S.genesis - 100n;
  add('s1-before-genesis-round1', S, preGenesis, 60n, 1n, '');

  // Thirty-second rounds: rounding up to the next round, and the bounds it can cross.
  const T = THIRTY_SECOND;
  const t7 = closeWithPhase(T, base, 7n);
  add('s30-delay120-phase7', T, t7, 120n, first(T, t7 + 120n), '');
  add('s30-delay600-phase7-too-late', T, t7, 600n, first(T, t7 + 600n), 'beacon_too_late');
  add('s30-delay60-prev-round-too-early', T, t7, 60n, first(T, t7 + 60n) - 1n, 'beacon_too_early');

  cases.sort((a, b) => (a.id < b.id ? -1 : 1));
  return `${JSON.stringify({ cases }, null, 2)}\n`;
}
