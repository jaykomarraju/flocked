// The beacon for a settlement (spec "Sealed picks" › Scheme): fetched from drand relays, which are
// used only for availability, and verified with BLS against the pinned chain for exactly
// `beaconRound` before any decryption. A signature that fails is discarded and fetched again. The
// relay that answered is logged by the caller, never written to the bundle.
import { QUICKNET, verifyBeacon, type DrandChain } from '@flocked/tlock';

/** drand's public quicknet relays (League of Entropy HTTP endpoints). */
export const QUICKNET_RELAYS: readonly string[] = Object.freeze([
  'https://api.drand.sh',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
  'https://drand.cloudflare.com',
]);

/** Retry every 3 s until beacon time + 10 min, then every 60 s (spec "Round lifecycle"). */
export const BEACON_FAST_RETRY_MS = 3_000;
export const BEACON_SLOW_RETRY_MS = 60_000;
/** ALERT_BEACON_LATE: still unavailable 10 minutes after beacon time. */
export const BEACON_LATE_AFTER_MS = 600_000;
/** Per-request timeout, so one hung relay can't stall the attempt. */
export const RELAY_TIMEOUT_MS = 5_000;

export interface RelayEnv {
  /**
   * Comma-separated relay base URLs (`<relay>/<chainHash>/public/<round>`). Optional for quicknet,
   * which defaults to QUICKNET_RELAYS; required for any other chain (the local drand network).
   */
  DRAND_RELAYS?: string;
}

/** The relays for `chain`, or an Error when a non-quicknet chain has none configured. */
export function relaysFor(env: RelayEnv, chain: DrandChain): string[] | Error {
  const configured = (env.DRAND_RELAYS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s !== '');
  for (const r of configured) {
    if (!/^https?:\/\/[^\s/]+/.test(r)) return new Error(`DRAND_RELAYS: not an http(s) URL: ${r}`);
  }
  if (configured.length > 0) return configured;
  if (chain.chainHash === QUICKNET.chainHash) return [...QUICKNET_RELAYS];
  return new Error('DRAND_RELAYS is required for a drand chain other than quicknet');
}

export interface VerifiedBeacon {
  round: number;
  /** 96 lowercase hex chars, verified for `round` on the pinned chain. */
  signature: string;
  /** The relay that served it (logs only). */
  relay: string;
}

export interface RelayFailure {
  relay: string;
  error: string;
}

export type BeaconFetch =
  | { ok: true; beacon: VerifiedBeacon; failures: RelayFailure[] }
  | { ok: false; failures: RelayFailure[] };

/**
 * One attempt: asks each relay in turn, starting at `start` (so successive attempts rotate), for
 * `round`, and returns the first signature that verifies. Never throws.
 */
export async function fetchVerifiedBeacon(i: {
  chain: DrandChain;
  round: number;
  relays: readonly string[];
  fetch: typeof fetch;
  start?: number;
  timeoutMs?: number;
}): Promise<BeaconFetch> {
  const failures: RelayFailure[] = [];
  const n = i.relays.length;
  for (let k = 0; k < n; k++) {
    const relay = i.relays[((i.start ?? 0) + k) % n] ?? '';
    const r = await askRelay(i, relay).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : String(e),
    }));
    if ('signature' in r) {
      return { ok: true, beacon: { round: i.round, signature: r.signature, relay }, failures };
    }
    failures.push({ relay, error: r.error });
  }
  return { ok: false, failures };
}

/** The verified signature from one relay, or why not. */
async function askRelay(
  i: { chain: DrandChain; round: number; fetch: typeof fetch; timeoutMs?: number },
  relay: string,
): Promise<{ signature: string } | { error: string }> {
  const res = await i.fetch(`${relay}/${i.chain.chainHash}/public/${i.round}`, {
    signal: AbortSignal.timeout(i.timeoutMs ?? RELAY_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return { error: `http ${res.status}` };
  const body = (await res.json().catch(() => null)) as {
    round?: unknown;
    signature?: unknown;
  } | null;
  if (body?.round !== i.round) return { error: `wrong round ${String(body?.round)}` };
  if (typeof body.signature !== 'string') return { error: 'no signature' };
  const signature = body.signature.toLowerCase();
  if (!verifyBeacon(i.chain, i.round, signature)) return { error: 'signature failed verification' };
  return { signature };
}

/** How long to wait before the next attempt. */
export function beaconRetryMs(nowMs: number, beaconTimeSec: number): number {
  return nowMs < beaconTimeSec * 1000 + BEACON_LATE_AFTER_MS
    ? BEACON_FAST_RETRY_MS
    : BEACON_SLOW_RETRY_MS;
}

export function isBeaconLate(nowMs: number, beaconTimeSec: number): boolean {
  return nowMs >= beaconTimeSec * 1000 + BEACON_LATE_AFTER_MS;
}
