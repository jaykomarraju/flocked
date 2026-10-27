// Stand-ins for everything outside the watcher: the public API, its own chain reads and the paging
// webhook. They hold fixed state, so a test says exactly what the world looks like.
import { QUICKNET } from '@flocked/tlock';
import { memorySource, verifyRound, type ChainReader } from '@flocked/verify';
import type { Address } from 'viem';
import type { ApiClient, PublishedConfig, PublishedRound } from '../src/api.js';
import type { WalletAttestations } from '../src/attest.js';
import type {
  OnchainRound,
  OnchainRoundConfig,
  ProposedLog,
  RoundCreatedLog,
  RoundRefundedLog,
  WatcherChain,
} from '../src/chain.js';
import type { WatcherDeps } from '../src/deps.js';
import { TREASURY } from './fixture.js';

export const DEPLOYMENT = {
  escrow: '0x1111111111111111111111111111111111111111',
  anchor: '0x2222222222222222222222222222222222222222',
  usdc: '0x3333333333333333333333333333333333333333',
  deployBlock: 0n,
} as const;

export class FakeApi implements ApiClient {
  rounds: PublishedRound[] = [];
  todayId: string | null = null;
  previousRoundId: string | null = null;
  archive: string[] = [];
  /** Set to throw from every call, as an unreachable API would. */
  down: Error | null = null;

  today() {
    if (this.down) return Promise.reject(this.down);
    const round = this.rounds.find((r) => r.id === this.todayId) ?? null;
    return Promise.resolve({ round, previousRoundId: this.previousRoundId });
  }
  round(id: string) {
    if (this.down) return Promise.reject(this.down);
    return Promise.resolve(this.rounds.find((r) => r.id === id) ?? null);
  }
  recentRoundIds(limit: number) {
    if (this.down) return Promise.reject(this.down);
    return Promise.resolve(this.archive.slice(0, limit));
  }
}

export class FakeChain implements WatcherChain {
  treasuryAddress: Address = TREASURY;
  created: RoundCreatedLog | null = null;
  roundState: OnchainRound | null = null;
  refunds: RoundRefundedLog[] = [];
  proposalLogs: ProposedLog[] = [];
  times = new Map<bigint, number>();
  refundTimeoutSec = 7_200n;
  /** Set to throw from every read, as an unreachable RPC would. */
  down: Error | null = null;

  private check() {
    if (this.down) throw this.down;
  }
  treasury() {
    this.check();
    return Promise.resolve(this.treasuryAddress);
  }
  refundTimeout() {
    this.check();
    return Promise.resolve(this.refundTimeoutSec);
  }
  roundCreated() {
    this.check();
    return Promise.resolve(this.created);
  }
  round() {
    this.check();
    if (!this.roundState) throw new Error('no round');
    return Promise.resolve(this.roundState);
  }
  roundRefunded() {
    this.check();
    return Promise.resolve(this.refunds);
  }
  proposed() {
    this.check();
    return Promise.resolve(this.proposalLogs);
  }
  blockTime(n: bigint) {
    this.check();
    return Promise.resolve(this.times.get(n) ?? null);
  }
}

/** A paging webhook that records what it was sent. */
export class FakePager {
  readonly posts: { url: string; body: unknown; auth: string | null }[] = [];
  status = 200;

  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    this.posts.push({
      url,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown,
      auth: headers.get('authorization'),
    });
    return Promise.resolve(new Response('', { status: this.status }));
  };
}

export function onchainConfigOf(s: NonNullable<PublishedConfig['stakes']>): OnchainRoundConfig {
  return {
    opensAt: BigInt(s.opensAt),
    closesAt: BigInt(s.closesAt),
    beaconRound: BigInt(s.beaconRound),
    stake: BigInt(s.stake),
    feeBps: s.feeBps,
    creatorBps: s.creatorBps,
    capMultiple: s.capMultiple,
    minEntrants: s.minEntrants,
    creator: s.creator as Address,
    questionHash: s.questionHash as `0x${string}`,
  };
}

export interface FakeDepsOptions {
  api: FakeApi;
  chain: FakeChain;
  reader: ChainReader;
  /** Bundle objects the public route serves. */
  objects: Map<string, Uint8Array>;
  attestations?: WalletAttestations;
  countryAllow?: string[];
  pager?: FakePager;
}

/** Real `verifyRound`, over the bundle objects a test holds in memory. */
export function fakeDeps(o: FakeDepsOptions): WatcherDeps {
  return {
    api: o.api,
    chain: o.chain,
    reader: o.reader,
    attestations: () => Promise.resolve(o.attestations ?? { verifiedAccount: true, country: 'US' }),
    drand: QUICKNET,
    deployment: DEPLOYMENT,
    chainId: 31337,
    bundleBaseUrl: 'memory:',
    rpcUrl: 'http://127.0.0.1:1',
    countryAllow: o.countryAllow ?? ['US'],
    verify: (options) => verifyRound({ ...options, source: memorySource(o.objects) }),
    fetch: o.pager?.fetch ?? fetch,
  };
}
