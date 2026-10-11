// The round lifecycle on the local stack with no manual step (W4-D; AC-6, first half): a daily-shaped
// round a minute long is created unlocked, as the scheduler's hourly job would, and from there only
// the stack's cron driver (e2e/stack/cron.mjs, standing in for Cloudflare's cron triggers) and the
// Durable Objects' own alarms move it. The scheduler's tick locks it and queues its Free lock leaf,
// the AnchorDO writes the leaf to the local FlockedAnchor, the RoundDO opens the round at opensAt and
// closes it at closesAt, the AnchorDO writes the commitment root before the beacon, and the
// indexer mirrors both writes into round_modes. The test only signs players in and enters picks.
//
// The game clock stays on wall time throughout (anvil and drand run on it).
//
//   pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/lifecycle-open-close.test.ts
import { flockedAnchorAbi } from '@flocked/abi';
import { freeCommitmentTree } from '@flocked/settle';
import {
  AuthSessionResponseSchema,
  CreateEntryResponseSchema,
  MODE_CODES,
  SiweNonceResponseSchema,
  roundKey,
  ulidToBytes,
  type CreateEntryResponse,
} from '@flocked/shared';
import {
  chainFromEnv,
  encodePlaintext,
  encryptPick,
  roundRefFromUlid,
  toBase64Url,
} from '@flocked/tlock';
import { createPublicClient, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { beforeAll, describe, expect, it } from 'vitest';
import { readDevVars, readState } from '../stack/env.mjs';

interface StackState {
  ready: boolean;
  apiUrl: string;
  appOrigin: string;
  drand: { url: string; chainHash: string; publicKey: string; genesis: number; period: number };
  anvil: { rpcUrl: string; chainId: number };
  contracts: { anchor: Hex };
}

interface SeamRound {
  status: string;
  state: { status: string; beaconRound: number; beaconTimeSec: number };
  free: {
    status: string;
    commitmentRoot: Hex | null;
    lockTx: Hex | null;
    commitTx: Hex | null;
  };
  anchorEvents: { event: string; txHash: Hex; removed: boolean }[];
}

const state = readState() as StackState | null;
const vars = readDevVars() as Record<string, string> | null;
if (!state?.ready || !vars) throw new Error('the local stack is not up: run `pnpm stack:up` first');

const chain = chainFromEnv({
  DRAND_CHAIN_HASH: state.drand.chainHash,
  DRAND_PUBLIC_KEY: state.drand.publicKey,
  DRAND_GENESIS: String(state.drand.genesis),
  DRAND_PERIOD: String(state.drand.period),
});
const anvil = createPublicClient({ transport: http(state.anvil.rpcUrl) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, init: { body?: unknown; token?: string } = {}) {
  const res = await fetch(`${state!.apiUrl}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.json() };
}

const seam = (path: string, body?: unknown) =>
  call(`/__test${path}`, { body, token: vars.FLOCKED_TEST_SEAM_KEY });

async function poll<T>(what: string, untilMs: number, fn: () => Promise<T | null>): Promise<T> {
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    if (Date.now() > untilMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const readRound = async (id: string): Promise<SeamRound | null> => {
  const res = await seam(`/rounds/${id}`);
  return res.status === 200 ? (res.body as SeamRound) : null;
};

/** SIWE sign-in (creating the account behind Turnstile's always-pass test secret). */
async function signIn(account: PrivateKeyAccount): Promise<string> {
  const nonce = SiweNonceResponseSchema.parse(
    (await call('/api/v1/auth/siwe/nonce', { body: {} })).body,
  );
  const origin = new URL(state!.appOrigin);
  const message = createSiweMessage({
    address: account.address,
    chainId: state!.anvil.chainId,
    domain: origin.host,
    nonce: nonce.nonce,
    uri: origin.origin,
    version: '1',
    issuedAt: new Date(),
  });
  const res = await call('/api/v1/auth/siwe/verify', {
    body: {
      message,
      signature: await account.signMessage({ message }),
      turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
      transport: 'bearer',
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return AuthSessionResponseSchema.parse(res.body).token!;
}

const anchorOf = (key: Hex) =>
  anvil.readContract({
    address: state.contracts.anchor,
    abi: flockedAnchorAbi,
    functionName: 'getAnchor',
    args: [key],
  });

describe('local stack: open → closed → committed with no manual step', () => {
  const tokens: string[] = [];
  const entries: CreateEntryResponse[] = [];
  let roundId: string;
  let key: Hex;
  let opensAt: number;
  let closesAt: number;
  let round: SeamRound;

  beforeAll(async () => {
    // Wall time for the Worker and every DO (another test may have pinned the clock).
    await seam('/clock', { nowMs: null });
    for (let i = 0; i < 2; i++)
      tokens.push(await signIn(privateKeyToAccount(generatePrivateKey())));
  });

  it('the scheduler locks a new round and its Free lock leaf lands onchain', async () => {
    const t0 = Math.ceil(Date.now() / 1000) * 1000;
    opensAt = t0 + 20_000;
    closesAt = opensAt + 40_000;
    const res = await seam('/rounds/scheduled', { opensAt, closesAt, beaconDelay: 120 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    roundId = (res.body as { roundId: string }).roundId;
    key = roundKey(roundId, 'free');

    // Locked by a cron tick, the leaf written by the AnchorDO and mirrored by the indexer.
    round = await poll('the lock leaf', opensAt, async () => {
      const r = await readRound(roundId);
      return r?.free.lockTx && r.anchorEvents.some((e) => e.event === 'Locked') ? r : null;
    });
    expect(['scheduled', 'open']).toContain(round.state.status);
    const onchain = await anchorOf(key);
    expect(onchain.lockedAt).toBeGreaterThan(0n);
    expect(onchain.lockedAt).toBeLessThan(BigInt(closesAt / 1000));
    expect(onchain.closesAt).toBe(BigInt(closesAt / 1000));
    expect(onchain.beaconRound).toBe(BigInt(round.state.beaconRound));
    expect(round.anchorEvents.find((e) => e.event === 'Locked')?.txHash).toBe(round.free.lockTx);
  });

  it('opens at opensAt on the RoundDO alarm and takes sealed picks', async () => {
    round = await poll('the round to open', opensAt + 15_000, async () => {
      const r = await readRound(roundId);
      return r?.status === 'open' && r.state.status === 'open' ? r : null;
    });
    expect(Date.now()).toBeGreaterThanOrEqual(opensAt);

    for (const [i, token] of tokens.entries()) {
      const pt = encodePlaintext({
        roundRef: roundRefFromUlid(roundId),
        optionIndex: (i % 2) as 0 | 1,
        nonce: crypto.getRandomValues(new Uint8Array(16)),
      });
      const ct = await encryptPick(chain, round.state.beaconRound, pt);
      const res = await call(`/api/v1/rounds/${roundId}/entries`, {
        token,
        body: { stake: '10', ciphertext: toBase64Url(ct), turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      entries.push(CreateEntryResponseSchema.parse(res.body));
    }
  });

  it('closes at closesAt and commits the root onchain before the beacon, once', async () => {
    round = await poll('the commitment', closesAt + 75_000, async () => {
      const r = await readRound(roundId);
      return r?.status === 'closed' &&
        r.free.commitTx &&
        r.anchorEvents.some((e) => e.event === 'Committed')
        ? r
        : null;
    });
    const beaconTimeSec = round.state.beaconTimeSec;

    // The root covers both receipts, in D1 and onchain.
    const tree = freeCommitmentTree(
      entries.map(({ receipt }) => ({
        roundId: ulidToBytes(roundId),
        mode: MODE_CODES.free,
        userIdHash: receipt.userIdHash as Hex,
        stake: BigInt(receipt.stake),
        commitment: receipt.commitment as Hex,
        seq: receipt.seq,
      })),
    );
    expect(round.free.commitmentRoot).toBe(tree.root);
    const onchain = await anchorOf(key);
    expect(onchain.commitmentRoot).toBe(tree.root);
    expect(onchain.entryCount).toBe(2);
    expect(onchain.totalStake).toBe(20n);
    expect(onchain.committedAt).toBeGreaterThanOrEqual(BigInt(closesAt / 1000));
    expect(onchain.committedAt).toBeLessThan(BigInt(beaconTimeSec));
    expect(round.free.status).toBe('pending');

    // Exactly one lock leaf and one commitment for the key, on the chain and in the mirror.
    const logs = async (eventName: 'Locked' | 'Committed') =>
      anvil.getContractEvents({
        address: state.contracts.anchor,
        abi: flockedAnchorAbi,
        eventName,
        args: { roundKey: key },
        fromBlock: 0n,
      });
    const [locked, committed] = await Promise.all([logs('Locked'), logs('Committed')]);
    expect(locked).toHaveLength(1);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.transactionHash).toBe(round.free.commitTx);
    const block = await anvil.getBlock({ blockHash: committed[0]!.blockHash });
    expect(block.timestamp).toBeLessThan(BigInt(beaconTimeSec));
    expect(round.anchorEvents.filter((e) => !e.removed).map((e) => e.event)).toEqual([
      'Locked',
      'Committed',
    ]);
  });
});
