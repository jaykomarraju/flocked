// The round config check (spec "Sealed picks (timelock encryption)" › Round config check (Stakes)):
// before it will build `enter`, the client reads the round's `RoundConfig` from FlockedEscrow
// through its own public Base RPC — never the API — and compares every field with the config the
// API published at lock. Any mismatch refuses the entry: the published record is what the player
// agreed to, and the chain is what their money would obey.
//
// It also checks `beaconRound` (not a `RoundConfig` field) against the published `beaconDelay`: it
// must be the first quicknet round at or after `closesAt + beaconDelay`. And it measures the locked
// config against the launch defaults, so a round that is not the usual one says so prominently
// before the player stakes (`nonDefaults`), whether or not the API published an override row.
import { flockedEscrowAbi } from '@flocked/abi';
import type { RoundView, StakesConfigWire } from '@flocked/shared';
import { firstRoundAtOrAfter } from '@flocked/tlock';
import { createPublicClient, http, isAddressEqual, type Address } from 'viem';
import type { ClientChain } from '../../crypto/chain';

/** Launch defaults (spec: stake 5 USDC, 500/100 bps, cap 10, minEntrants 20 daily / 3 room). */
export const LAUNCH_DEFAULTS = {
  stake: 5_000_000n,
  feeBps: 500,
  creatorBps: 100,
  capMultiple: 10,
  minEntrantsDaily: 20,
  minEntrantsRoom: 3,
} as const;

/** The `RoundConfig` fields the client compares, in the order it reports them. */
export const CHECKED_FIELDS = [
  'opensAt',
  'closesAt',
  'beaconRound',
  'stake',
  'feeBps',
  'creatorBps',
  'capMultiple',
  'minEntrants',
  'creator',
  'questionHash',
] as const;
export type CheckedField = (typeof CHECKED_FIELDS)[number];

/** One field whose onchain value differs from the published one. Both are shown to the player. */
export interface ConfigMismatch {
  field: CheckedField | 'beaconRound (delay)' | 'round';
  published: string;
  onchain: string;
}

/** One value that differs from the launch default, as the Today notice names it. */
export interface NonDefault {
  field: 'stake' | 'feeBps' | 'creatorBps' | 'capMultiple' | 'minEntrants';
  value: string;
  usual: string;
  /** The audit-log row that set it, when the API published one. */
  auditId: string | null;
}

export type ConfigCheck =
  | { ok: true; nonDefaults: NonDefault[] }
  /** The chain disagrees with the published record: the client will not build `enter`. */
  | { ok: false; reason: 'mismatch'; mismatches: ConfigMismatch[] }
  /** The chain could not be read; the client refuses rather than trusting the API alone. */
  | { ok: false; reason: 'unreadable' };

/** What the check reads onchain. Tests and the mocked world pass their own. */
export interface EscrowReader {
  roundConfig(chainRoundId: bigint): Promise<{
    opensAt: bigint;
    closesAt: bigint;
    beaconRound: bigint;
    stake: bigint;
    feeBps: number;
    creatorBps: number;
    capMultiple: number;
    minEntrants: number;
    creator: Address;
    questionHash: `0x${string}`;
  }>;
}

export function escrowReader(chain: ClientChain): EscrowReader {
  const client = createPublicClient({ transport: http(chain.rpcUrl) });
  return {
    async roundConfig(chainRoundId) {
      const round = await client.readContract({
        address: chain.escrow,
        abi: flockedEscrowAbi,
        functionName: 'getRound',
        args: [chainRoundId],
      });
      return { ...round.cfg };
    },
  };
}

const usdc = (n: bigint) => `${(Number(n) / 1e6).toFixed(2)} USDC`;

/** The values that differ from the launch defaults, with the audit ID the API published for each. */
export function nonDefaults(round: RoundView, stakes: StakesConfigWire): NonDefault[] {
  const overrides = round.config?.overrides ?? [];
  const auditFor = (field: string) =>
    overrides.find((o) => o.field === field || o.field === `stakes.${field}`)?.auditId ?? null;
  const out: NonDefault[] = [];
  const add = (field: NonDefault['field'], value: string, usual: string) =>
    out.push({ field, value, usual, auditId: auditFor(field) });

  if (BigInt(stakes.stake) !== LAUNCH_DEFAULTS.stake) {
    add('stake', usdc(BigInt(stakes.stake)), usdc(LAUNCH_DEFAULTS.stake));
  }
  if (stakes.feeBps !== LAUNCH_DEFAULTS.feeBps) {
    add('feeBps', String(stakes.feeBps), String(LAUNCH_DEFAULTS.feeBps));
  }
  if (stakes.creatorBps !== LAUNCH_DEFAULTS.creatorBps) {
    add('creatorBps', String(stakes.creatorBps), String(LAUNCH_DEFAULTS.creatorBps));
  }
  if (stakes.capMultiple !== LAUNCH_DEFAULTS.capMultiple) {
    add('capMultiple', String(stakes.capMultiple), String(LAUNCH_DEFAULTS.capMultiple));
  }
  const usualEntrants =
    round.roomId === null ? LAUNCH_DEFAULTS.minEntrantsDaily : LAUNCH_DEFAULTS.minEntrantsRoom;
  if (stakes.minEntrants !== usualEntrants) {
    add('minEntrants', String(stakes.minEntrants), String(usualEntrants));
  }
  return out;
}

/**
 * Every `RoundConfig` field onchain against the record published at lock, plus the beacon round
 * against the published `beaconDelay`. `ok: false` means the client refuses to build `enter`.
 */
export async function checkRoundConfig(i: {
  round: RoundView;
  chain: ClientChain;
  reader: EscrowReader;
}): Promise<ConfigCheck> {
  const stakes = i.round.config?.stakes;
  const beaconDelay = i.round.config?.beaconDelay;
  if (!stakes || beaconDelay === undefined) {
    return { ok: false, reason: 'mismatch', mismatches: [mismatch('round', 'no locked config')] };
  }

  let cfg: Awaited<ReturnType<EscrowReader['roundConfig']>>;
  try {
    cfg = await i.reader.roundConfig(BigInt(stakes.chainRoundId));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  // A round that was never created onchain reads as a zeroed config, which `enter` would revert on.
  if (cfg.closesAt === 0n && cfg.stake === 0n) {
    return {
      ok: false,
      reason: 'mismatch',
      mismatches: [mismatch('round', String(stakes.chainRoundId), 'not created')],
    };
  }

  const bad: ConfigMismatch[] = [];
  const same = (field: CheckedField, published: string, onchain: string) => {
    if (published !== onchain) bad.push({ field, published, onchain });
  };
  same('opensAt', String(stakes.opensAt), String(cfg.opensAt));
  same('closesAt', String(stakes.closesAt), String(cfg.closesAt));
  same('beaconRound', String(stakes.beaconRound), String(cfg.beaconRound));
  same('stake', String(BigInt(stakes.stake)), String(cfg.stake));
  same('feeBps', String(stakes.feeBps), String(cfg.feeBps));
  same('creatorBps', String(stakes.creatorBps), String(cfg.creatorBps));
  same('capMultiple', String(stakes.capMultiple), String(cfg.capMultiple));
  same('minEntrants', String(stakes.minEntrants), String(cfg.minEntrants));
  same('questionHash', stakes.questionHash, cfg.questionHash);
  if (!isAddressEqual(stakes.creator as Address, cfg.creator)) {
    bad.push({ field: 'creator', published: stakes.creator, onchain: cfg.creator.toLowerCase() });
  }

  // `beaconDelay` is not a RoundConfig field: the beacon round has to follow from it.
  const expected = firstRoundAtOrAfter(i.chain.drand, Number(cfg.closesAt) + beaconDelay);
  if (BigInt(expected) !== cfg.beaconRound) {
    bad.push({
      field: 'beaconRound (delay)',
      published: `${expected} (${beaconDelay}s after close)`,
      onchain: String(cfg.beaconRound),
    });
  }

  if (bad.length > 0) return { ok: false, reason: 'mismatch', mismatches: bad };
  return { ok: true, nonDefaults: nonDefaults(i.round, stakes) };
}

function mismatch(
  field: ConfigMismatch['field'],
  published: string,
  onchain = 'missing',
): ConfigMismatch {
  return { field, published, onchain };
}
