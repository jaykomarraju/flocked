// The `stack` fixture (W7-D): the running local stack (`pnpm stack:up`) as the specs see it. Its
// facts come from e2e/stack/.state.json and .dev.vars (env.mjs), never from new config: the API and
// seam URLs, anvil, the contracts, the drand chain and the role addresses. It also wraps the seam
// (`/__test/*`, keyed by the per-run FLOCKED_TEST_SEAM_KEY) and drand's containers.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chainFromEnv, type DrandChain } from '@flocked/tlock';
import {
  createPublicClient,
  createTestClient,
  http as viemHttp,
  type Address,
  type Hex,
  type PublicClient,
  type TestClient,
} from 'viem';
import { foundry } from 'viem/chains';
import { COMPOSE_FILE, RUN_DIR, readDevVars, readState } from '../stack/env.mjs';
import { http, type HttpInit, type HttpResult } from './http';

interface StackState {
  ready: boolean;
  apiUrl: string;
  appOrigin: string;
  coinbaseUrl: string;
  easUrl: string;
  turnstileUrl?: string;
  farcasterUrl: string;
  pushUrl?: string;
  farcasterNotifyUrl?: string;
  emailUrl?: string;
  drand: { url: string; chainHash: string; publicKey: string; genesis: number; period: number };
  anvil: { rpcUrl: string; chainId: number };
  contracts: { escrow: Address; usdc: Address; anchor: Address };
  addresses: Record<'deployer' | 'guardian' | 'operator' | 'admin' | 'treasury', Address>;
}

/** A settlement hold as the seam shows it (`settlement_holds`). */
export interface SeamHold {
  mode: 'free' | 'stakes';
  reason: 'foreign_entry' | 'void_rate' | 'refund_vetoed';
  txHash: Hex | null;
  createdAt: number;
  releasedAt: number | null;
  releasedBy: string | null;
}

/** The Stakes mode as `GET /__test/rounds/:id` shows it (seam.ts `stakesOf`). */
export interface SeamStakes {
  status: string;
  chainRoundId: string | null;
  refundReason: number | null;
  bundleHash: Hex | null;
  revealedAt: number | null;
  claimsOpenAt: number | null;
  finalAt: number | null;
  settlements: {
    seq: number;
    outcome: string;
    bundleHash: Hex | null;
    txHash: Hex | null;
    supersededAt: number | null;
  }[];
  payouts: { userId: string | null; wallet: string; kind: string; amount: number }[];
  entries: {
    userId: string | null;
    wallet: string;
    optionIndex: number | null;
    valid: boolean | null;
    voidReason: string | null;
    foreign: boolean;
  }[];
}

/** `GET /__test/rounds/:id` (seam.ts). */
export interface SeamRound {
  status: string;
  state: { status: string; beaconRound: number; beaconTimeSec: number };
  free: {
    status: string;
    refundReason: number | null;
    revealedAt: number | null;
    commitTx: Hex | null;
  } | null;
  stakes: SeamStakes | null;
  settlement: { outcome: string; bundleHash: Hex | null; txHash: Hex | null } | null;
  payouts: { userId: string; kind: string; amount: number }[];
  anchorEvents: { event: string; txHash: Hex; removed: boolean }[];
  holds: SeamHold[];
  entries: { userId: string; stake: number; optionIndex: number | null; valid: boolean | null }[];
}

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Stack {
  readonly apiUrl: string;
  readonly appOrigin: string;
  readonly coinbaseUrl: string;
  readonly easUrl: string;
  readonly turnstileUrl: string | null;
  /** The Farcaster Quick Auth mock (W3-A). */
  readonly farcasterUrl: string;
  /** The notification mocks (W9-A): a web push service, Farcaster's endpoint and hub, and email. */
  readonly notifyMocks: { push: string; farcaster: string; email: string } | null;
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly contracts: StackState['contracts'];
  readonly addresses: StackState['addresses'];
  readonly tosVersion: string;
  readonly drandUrl: string;
  readonly drandChain: DrandChain;
  readonly client: PublicClient;
  readonly testClient: TestClient;
  readonly #seamKey: string;
  /** Seam calls so far: a spec that may make none after its setup checks this did not move (AC-1). */
  seamCalls = 0;

  constructor() {
    const state = readState() as StackState | null;
    const vars = readDevVars() as Record<string, string> | null;
    if (!state?.ready || !vars?.FLOCKED_TEST_SEAM_KEY) {
      throw new Error('the local stack is not up: run `pnpm stack:up` first (e2e/stack/README.md)');
    }
    this.apiUrl = state.apiUrl;
    this.appOrigin = state.appOrigin;
    this.coinbaseUrl = state.coinbaseUrl;
    this.easUrl = state.easUrl;
    this.turnstileUrl = state.turnstileUrl ?? null;
    this.farcasterUrl = state.farcasterUrl;
    this.notifyMocks =
      state.pushUrl && state.farcasterNotifyUrl && state.emailUrl
        ? { push: state.pushUrl, farcaster: state.farcasterNotifyUrl, email: state.emailUrl }
        : null;
    this.rpcUrl = state.anvil.rpcUrl;
    this.chainId = state.anvil.chainId;
    this.contracts = state.contracts;
    this.addresses = state.addresses;
    this.tosVersion = vars.TOS_VERSION ?? '';
    this.drandUrl = state.drand.url;
    this.drandChain = chainFromEnv({
      DRAND_CHAIN_HASH: state.drand.chainHash,
      DRAND_PUBLIC_KEY: state.drand.publicKey,
      DRAND_GENESIS: String(state.drand.genesis),
      DRAND_PERIOD: String(state.drand.period),
    });
    this.#seamKey = vars.FLOCKED_TEST_SEAM_KEY;
    const transport = viemHttp(this.rpcUrl);
    this.client = createPublicClient({ chain: foundry, transport });
    this.testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  }

  /** `/api/v1<path>`. */
  api<T = unknown>(path: string, init: HttpInit = {}): Promise<HttpResult<T>> {
    return http<T>(`${this.apiUrl}/api/v1${path}`, init);
  }

  /** `/__test<path>` with the seam key. POSTs are retried only when `idempotent` is passed. */
  seam<T = unknown>(path: string, body?: unknown, init: HttpInit = {}): Promise<HttpResult<T>> {
    this.seamCalls += 1;
    return http<T>(`${this.apiUrl}/__test${path}`, { ...init, body, token: this.#seamKey });
  }

  /** The seam's view of a round, or null before it is locked. */
  async seamRound(roundId: string): Promise<SeamRound | null> {
    const res = await this.seam<SeamRound>(`/rounds/${roundId}`);
    return res.status === 200 ? res.body : null;
  }

  /** The escrow's ticket-signer key, which `stack:up` writes beside (never into) the API's vars. */
  ticketSignerKey(): Hex {
    const text = readFileSync(join(RUN_DIR, 'ticket-signer.dev.vars'), 'utf8');
    const m = /^TICKET_SIGNER_KEY='?(0x[0-9a-fA-F]{64})'?$/m.exec(text);
    if (!m) throw new Error('no TICKET_SIGNER_KEY in e2e/stack/.run/ticket-signer.dev.vars');
    return m[1] as Hex;
  }

  /** Stops the drand network's containers (E2E-14). drand's own clock is never moved. */
  async stopDrand(): Promise<void> {
    await exec('docker', ['compose', '-f', COMPOSE_FILE, 'stop'], { timeout: 60_000 });
  }

  /** Starts drand's containers again and waits until HTTP serves a beacon newer than `afterRound`. */
  async startDrand(afterRound = 0): Promise<number> {
    await exec('docker', ['compose', '-f', COMPOSE_FILE, 'start'], { timeout: 60_000 });
    return poll('drand to serve new beacons', 180_000, async () => {
      const res = await fetch(`${this.drandUrl}/public/latest`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return null;
      const { round } = (await res.json()) as { round: number };
      return round > afterRound ? round : null;
    });
  }

  /** The newest beacon drand serves over HTTP, or null when it answers nothing. */
  async latestBeacon(): Promise<number | null> {
    try {
      const res = await fetch(`${this.drandUrl}/public/latest`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok ? ((await res.json()) as { round: number }).round : null;
    } catch {
      return null;
    }
  }
}

/** Polls `fn` every `intervalMs` until it returns non-null, or throws naming `what` after `timeoutMs`. */
export async function poll<T>(
  what: string,
  timeoutMs: number,
  fn: () => Promise<T | null>,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      const why = last instanceof Error ? `: ${last.message}` : '';
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${why}`,
      );
    }
    await sleep(intervalMs);
  }
}
