// A round as the client follows it live: the WebSocket's `state` snapshot plus the events after it
// (spec "Real-time and the reveal"), or `GET /rounds/:id` while the socket is down (decision E7).
//
// `applyMessage` is idempotent and never moves a round backwards: a shard event can arrive twice, and
// late (a timed-out fan-out is retried, W7-F1 R5), and a reconnect's `state` can come from a snapshot a
// second old (RoundViewerDO). So counts only grow, statuses only advance, and a revealed result stays
// unless the mode is refunded (a Stakes veto), which the status says.
import type {
  ModeStatus,
  RoundStatus,
  RoundView,
  WsRevealResult,
  WsServerMessage,
} from '@flocked/shared';
import type { Mode } from '../ui/ModeToggle';

export interface LiveMode {
  status: ModeStatus;
  entrantCount: number;
  /** Points (Free) or USDC base units (Stakes). */
  pool: bigint;
  revealedAt: number | null;
  claimsOpenAt: number | null;
  /** The refund code (1–8, `REFUND_REASONS`). */
  refundReason: number | null;
  result: WsRevealResult | null;
  /** A Stakes refund proposal that isn't final yet. */
  provisional: boolean;
  /** When a refund became (or becomes) final, epoch ms. */
  finalAt: number | null;
  /**
   * The onchain proposal this mode's state came from, as its `claimsOpenAt` (epoch ms): a settlement
   * proposal's `claimsOpenAt`, a provisional refund's `finalAt`. Null while no proposal is known.
   * `FlockedEscrow` sets it to `block.timestamp + CHALLENGE_WINDOW` on every proposal and refuses a
   * veto once it has passed, so each re-proposal after a veto carries a strictly later one. That
   * makes it the only thing that tells a new proposal from a stale one at the same rank (see
   * `stale`, W9-Z review R5).
   */
  proposedAt: number | null;
}

export interface LiveRound {
  roundId: string;
  status: RoundStatus;
  /** Unix seconds. */
  opensAt: number;
  closesAt: number;
  beaconRound: number;
  beaconTime: number;
  /** Server clock minus this device's clock, ms (from the last `state`); 0 until one arrives. */
  skewMs: number;
  modes: Partial<Record<Mode, LiveMode>>;
}

const ROUND_RANK: Record<RoundStatus, number> = { scheduled: 0, open: 1, closed: 2 };
const MODE_RANK: Record<ModeStatus, number> = {
  pending: 0,
  revealing: 1,
  settle_proposed: 2,
  refund_proposed: 2,
  settled: 3,
  refunded: 3,
  voided: 3,
};

/** `settle_proposed` and `refund_proposed`: the two statuses a guardian veto can swap between. */
const PROPOSED_RANK = MODE_RANK.settle_proposed;

const later = <T extends string>(rank: Record<T, number>, a: T, b: T): T =>
  rank[b] >= rank[a] ? b : a;
const max = (a: bigint, b: bigint) => (b > a ? b : a);

function emptyMode(): LiveMode {
  return {
    status: 'pending',
    entrantCount: 0,
    pool: 0n,
    revealedAt: null,
    claimsOpenAt: null,
    refundReason: null,
    result: null,
    provisional: false,
    finalAt: null,
    proposedAt: null,
  };
}

/**
 * Whether `next` describes a proposal the client has already moved past (W9-Z review R5). A
 * settlement and a refund proposal share a rank, and `later` takes the newer on a tie, so without
 * this a late duplicate `refunded{provisional}` — or a reconnect `state` built from a snapshot a
 * second old — would move a mode that has since re-proposed as a settlement back to
 * `refund_proposed`, and `modePhase` would show a refund over the result. Only the proposal time
 * separates the two: a veto's re-proposal always carries a later one.
 */
function stale(prev: LiveMode, next: LiveMode): boolean {
  return (
    MODE_RANK[next.status] === PROPOSED_RANK &&
    next.proposedAt !== null &&
    prev.proposedAt !== null &&
    next.proposedAt < prev.proposedAt
  );
}

/** Merges a snapshot of one mode into what the client already knows, never going backwards. */
function mergeMode(prev: LiveMode | undefined, next: LiveMode): LiveMode {
  if (!prev) return next;
  // Counts still only grow; everything the superseded proposal says about the outcome is dropped.
  if (stale(prev, next)) {
    return {
      ...prev,
      entrantCount: Math.max(prev.entrantCount, next.entrantCount),
      pool: max(prev.pool, next.pool),
    };
  }
  const status = later(MODE_RANK, prev.status, next.status);
  const proposedAt =
    next.proposedAt !== null && (prev.proposedAt === null || next.proposedAt > prev.proposedAt)
      ? next.proposedAt
      : prev.proposedAt;
  return {
    status,
    entrantCount: Math.max(prev.entrantCount, next.entrantCount),
    pool: max(prev.pool, next.pool),
    revealedAt: next.revealedAt ?? prev.revealedAt,
    claimsOpenAt: next.claimsOpenAt ?? prev.claimsOpenAt,
    refundReason: next.refundReason ?? prev.refundReason,
    result: next.result ?? prev.result,
    provisional: status === 'refund_proposed' ? next.provisional || prev.provisional : false,
    finalAt: next.finalAt ?? prev.finalAt,
    proposedAt,
  };
}

function mergeModes(prev: LiveRound['modes'], next: LiveRound['modes']): LiveRound['modes'] {
  const out: LiveRound['modes'] = { ...prev };
  for (const mode of ['free', 'stakes'] as const) {
    const n = next[mode];
    if (n) out[mode] = mergeMode(prev[mode], n);
  }
  return out;
}

function merge(prev: LiveRound | null, next: LiveRound): LiveRound {
  if (!prev || prev.roundId !== next.roundId) return next;
  return {
    ...next,
    status: later(ROUND_RANK, prev.status, next.status),
    modes: mergeModes(prev.modes, next.modes),
  };
}

/**
 * The round after one server message. Messages for another round are ignored, and so is anything
 * before the first `state` (the server always sends `state` first).
 */
export function applyMessage(
  prev: LiveRound | null,
  msg: WsServerMessage,
  nowMs: number = Date.now(),
): LiveRound | null {
  if (msg.type === 'state') {
    const modes: LiveRound['modes'] = {};
    for (const mode of ['free', 'stakes'] as const) {
      const m = msg.modes[mode];
      if (!m) continue;
      modes[mode] = {
        status: m.status,
        entrantCount: m.entrantCount,
        pool: BigInt(m.pool),
        revealedAt: m.revealedAt,
        claimsOpenAt: m.claimsOpenAt,
        refundReason: m.refundReason,
        result: m.result,
        provisional: m.status === 'refund_proposed',
        finalAt: m.status === 'refund_proposed' ? m.claimsOpenAt : null,
        proposedAt: MODE_RANK[m.status] === PROPOSED_RANK ? m.claimsOpenAt : null,
      };
    }
    return merge(prev, {
      roundId: msg.roundId,
      status: msg.status,
      opensAt: msg.opensAt,
      closesAt: msg.closesAt,
      beaconRound: msg.beaconRound,
      beaconTime: msg.beaconTime,
      skewMs: msg.serverTime - nowMs,
      modes,
    });
  }
  if (!prev || prev.roundId !== msg.roundId) return prev;
  switch (msg.type) {
    case 'counts': {
      const modes: LiveRound['modes'] = {};
      for (const mode of ['free', 'stakes'] as const) {
        const c = msg.modes[mode];
        const p = prev.modes[mode];
        if (c) {
          modes[mode] = {
            ...(p ?? emptyMode()),
            entrantCount: c.entrantCount,
            pool: BigInt(c.pool),
          };
        }
      }
      return { ...prev, modes: mergeModes(prev.modes, modes) };
    }
    case 'closed':
      return {
        ...prev,
        status: later(ROUND_RANK, prev.status, 'closed'),
        closesAt: msg.closesAt,
        beaconRound: msg.beaconRound,
        beaconTime: msg.beaconTime,
      };
    case 'revealing': {
      const p = prev.modes[msg.mode] ?? emptyMode();
      return {
        ...prev,
        modes: mergeModes(prev.modes, { [msg.mode]: { ...p, status: 'revealing' } }),
      };
    }
    case 'revealed': {
      const p = prev.modes[msg.mode] ?? emptyMode();
      return {
        ...prev,
        modes: mergeModes(prev.modes, {
          [msg.mode]: {
            ...p,
            status: msg.mode === 'free' ? 'settled' : 'settle_proposed',
            revealedAt: p.revealedAt ?? nowMs,
            claimsOpenAt: msg.claimsOpenAt ?? p.claimsOpenAt,
            // Stakes only: Free settles outright and has no proposal to supersede.
            proposedAt: msg.claimsOpenAt ?? p.proposedAt,
            result: { winningOption: msg.winningOption, tally: msg.tally },
          },
        }),
      };
    }
    case 'refunded': {
      const p = prev.modes[msg.mode] ?? emptyMode();
      return {
        ...prev,
        modes: mergeModes(prev.modes, {
          [msg.mode]: {
            ...p,
            status: msg.provisional ? 'refund_proposed' : 'refunded',
            refundReason: msg.refundReason,
            provisional: msg.provisional,
            finalAt: msg.finalAt,
            // A proposal's `finalAt` is its `claimsOpenAt`; a final refund supersedes by rank.
            proposedAt: msg.provisional ? msg.finalAt : p.proposedAt,
          },
        }),
      };
    }
  }
}

/** A `GET /rounds/:id` answer as a snapshot, merged the same way (the polling fallback). */
export function applyRoundView(prev: LiveRound | null, round: RoundView): LiveRound {
  const modes: LiveRound['modes'] = {};
  for (const mode of ['free', 'stakes'] as const) {
    const m = round.modes[mode];
    if (!m) continue;
    const s = m.settlement;
    modes[mode] = {
      status: m.status,
      entrantCount: m.entrantCount,
      pool: BigInt(m.pool),
      revealedAt: m.revealedAt,
      claimsOpenAt: m.claimsOpenAt,
      refundReason: m.refundReason,
      result:
        s && s.outcome === 'settled' && s.winningOption !== null
          ? { winningOption: s.winningOption, tally: s.tally }
          : null,
      provisional: m.status === 'refund_proposed',
      finalAt: m.finalAt ?? (m.status === 'refund_proposed' ? m.claimsOpenAt : null),
      proposedAt: MODE_RANK[m.status] === PROPOSED_RANK ? m.claimsOpenAt : null,
    };
  }
  return merge(prev, {
    roundId: round.id,
    status: round.status,
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    beaconRound: round.beaconRound,
    beaconTime: round.beaconTime,
    skewMs: prev?.roundId === round.id ? prev.skewMs : 0,
    modes,
  });
}

/** Where one mode of a round stands for the player, at `nowMs` on the server's clock. */
export type ModePhase = 'open' | 'unsealing' | 'counting' | 'revealed' | 'refunded';

export function modePhase(round: LiveRound, mode: Mode, nowMs: number): ModePhase {
  const m = round.modes[mode];
  if (m && (m.status === 'refunded' || m.status === 'refund_proposed' || m.status === 'voided')) {
    return 'refunded';
  }
  if (m?.result) return 'revealed';
  if (round.status !== 'closed' && nowMs < round.closesAt * 1000) return 'open';
  if (nowMs < round.beaconTime * 1000) return 'unsealing';
  return 'counting';
}
