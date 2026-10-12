// A Free round settles end to end on the local stack (W5-D): 50 players enter a daily-shaped round
// that only the cron driver and the Durable Objects' alarms move. At beacon time the RoundDO enqueues
// the settle job; the SettlementDO fetches the local drand beacon, fans decryption out over the
// decrypt queue, reduces into a write-once bundle in R2 and runs applyFree: the ledger and balances,
// `settled`, the RoundDO result, the manifest anchored on the local FlockedAnchor, archival. The
// test checks the outcome against @flocked/settle run here in Node on what the players sealed.
//
//   pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/free-settle.test.ts
import { flockedAnchorAbi } from '@flocked/abi';
import { settle, type EntryInput, type Payout } from '@flocked/settle';
import {
  AuthSessionResponseSchema,
  CreateEntryResponseSchema,
  MeResponseSchema,
  SiweNonceResponseSchema,
  roundKey,
  type CreateEntryResponse,
} from '@flocked/shared';
import {
  chainFromEnv,
  encodePlaintext,
  encryptPick,
  roundRefFromUlid,
  toBase64Url,
} from '@flocked/tlock';
import { createPublicClient, http, keccak256, type Hex } from 'viem';
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
  state: {
    status: string;
    beaconRound: number;
    beaconTimeSec: number;
    modes: { free?: { status: string } };
  };
  free: {
    status: string;
    refundReason: number | null;
    bundleHash: Hex | null;
    revealedAt: number | null;
  };
  settlement: {
    outcome: string;
    bundleHash: Hex;
    manifestKey: string;
    txHash: Hex | null;
    dust: number;
  } | null;
  payouts: { userId: string; kind: string; amount: number }[];
  anchorEvents: { event: string; txHash: Hex; removed: boolean }[];
  entries: {
    userId: string;
    seq: number;
    optionIndex: 0 | 1 | null;
    valid: boolean | null;
    voidReason: string | null;
    archived: boolean;
  }[];
}

interface Manifest {
  roundId: string;
  mode: string;
  beaconRound: number;
  entryCount: number;
  payoutRoot: Hex | null;
  record: { outcome: string; winner: number | null; n: string[]; w: string[]; dust: string };
  chunks: { key: string; hash: Hex; entries: number }[];
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

/** Each player has its own client IP, so 50 sign-ins don't share one per-IP auth bucket. */
async function call(path: string, init: { body?: unknown; token?: string; ip?: string } = {}) {
  const res = await fetch(`${state!.apiUrl}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.ip ? { 'cf-connecting-ip': init.ip } : {}),
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
    await sleep(1000);
  }
}

const readRound = async (id: string): Promise<SeamRound | null> => {
  const res = await seam(`/rounds/${id}`);
  return res.status === 200 ? (res.body as SeamRound) : null;
};

async function bundleObject(roundId: string, file: string): Promise<Uint8Array> {
  const res = await fetch(`${state!.apiUrl}/__test/bundles/${roundId}/free/${file}`, {
    headers: { authorization: `Bearer ${vars!.FLOCKED_TEST_SEAM_KEY}` },
  });
  expect(res.status, file).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

async function signIn(account: PrivateKeyAccount, ip: string): Promise<string> {
  const nonce = SiweNonceResponseSchema.parse(
    (await call('/api/v1/auth/siwe/nonce', { body: {}, ip })).body,
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
    ip,
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

async function globalBalance(p: Player): Promise<bigint> {
  const res = await call('/api/v1/me', { token: p.token, ip: p.ip });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return BigInt(MeResponseSchema.parse(res.body).balances.global);
}

interface Player {
  ip: string;
  token: string;
  /** 0 or 1, or null for a sealed plaintext with option byte 2 (VOID `bad_option`). */
  option: 0 | 1 | null;
  stake: bigint;
  entry?: CreateEntryResponse;
  /** The global balance once entered (stake taken, any daily grant given). */
  before?: bigint;
}

const PLAYERS = 50;
const STAKES = [10n, 25n, 50n, 100n] as const;
/** 17 on option 0 (the minority, so it wins), 32 on option 1, and one VOID (player 7). */
const optionOf = (i: number): 0 | 1 | null => (i === 7 ? null : i % 3 === 0 ? 0 : 1);

describe('local stack: a Free round with 50 entries settles, anchors its bundle, and pays out', () => {
  const players: Player[] = [];
  let roundId: string;
  let key: Hex;
  let opensAt: number;
  let closesAt: number;
  let round: SeamRound;

  beforeAll(async () => {
    // Wall time for the Worker and every DO (another test may have pinned the clock).
    await seam('/clock', { nowMs: null });
  });

  it('signs 50 players in, and the scheduler locks and opens a new round', async () => {
    const accounts = Array.from({ length: PLAYERS }, () =>
      privateKeyToAccount(generatePrivateKey()),
    );
    for (let i = 0; i < PLAYERS; i += 10) {
      const batch = accounts.slice(i, i + 10).map(async (a, k) => {
        const ip = `10.55.${i + k}.1`;
        return { ip, token: await signIn(a, ip) };
      });
      for (const { ip, token } of await Promise.all(batch)) {
        const n = players.length;
        players.push({ ip, token, option: optionOf(n), stake: STAKES[n % STAKES.length]! });
      }
    }
    expect(players.filter((p) => p.option === 0)).toHaveLength(17);
    expect(players.filter((p) => p.option === 1)).toHaveLength(32);

    const t0 = Math.ceil(Date.now() / 1000) * 1000;
    opensAt = t0 + 20_000;
    closesAt = opensAt + 60_000;
    const res = await seam('/rounds/scheduled', { opensAt, closesAt, beaconDelay: 90 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    roundId = (res.body as { roundId: string }).roundId;
    key = roundKey(roundId, 'free');
    round = await poll('the round to open', opensAt + 20_000, async () => {
      const r = await readRound(roundId);
      return r?.status === 'open' && r.state.status === 'open' ? r : null;
    });
  });

  it('takes 50 sealed picks, one of them a VOID', async () => {
    for (const p of players) {
      const pt = encodePlaintext({
        roundRef: roundRefFromUlid(roundId),
        optionIndex: p.option ?? 0,
        nonce: crypto.getRandomValues(new Uint8Array(16)),
      });
      if (p.option === null) pt[17] = 2; // the option byte: a well-formed ciphertext, a bad pick
      const ct = await encryptPick(chain, round.state.beaconRound, pt);
      const res = await call(`/api/v1/rounds/${roundId}/entries`, {
        token: p.token,
        ip: p.ip,
        body: {
          stake: String(p.stake),
          ciphertext: toBase64Url(ct),
          turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      p.entry = CreateEntryResponseSchema.parse(res.body);
      p.before = await globalBalance(p);
    }
    expect(Date.now()).toBeLessThan(closesAt);
  });

  it('settles after the beacon: the bundle in R2, anchored onchain, the ledger applied', async () => {
    const beaconMs = round.state.beaconTimeSec * 1000;
    round = await poll('the settlement and its manifest anchor', beaconMs + 150_000, async () => {
      const r = await readRound(roundId);
      return r?.free.status === 'settled' &&
        r.settlement?.txHash &&
        r.anchorEvents.some((e) => e.event === 'ManifestAnchored')
        ? r
        : null;
    });
    expect(Date.now()).toBeGreaterThanOrEqual(beaconMs);

    // What the players sealed, settled here in Node.
    const inputs: EntryInput[] = players.map((p) => ({
      account: p.entry!.receipt.userIdHash,
      stake: p.stake,
      option: p.option,
      voidReason: p.option === null ? 'bad_option' : null,
    }));
    const expected = settle(inputs, {
      feeBps: 0,
      creatorBps: 0,
      capMultiple: 10,
      minEntrants: 1,
      creatorAwardBps: 0,
    });
    expect(expected.record.outcome).toBe('settled');
    expect(expected.record.winner).toBe(0);

    // The bundle in R2: its manifest is the anchored bytes, and its chunk matches its hash.
    const bundleHash = round.free.bundleHash!;
    const manifestBytes = await bundleObject(roundId, 'manifest.json');
    expect(keccak256(manifestBytes)).toBe(bundleHash);
    expect(round.settlement).toMatchObject({
      outcome: 'settled',
      bundleHash,
      manifestKey: `bundles/${roundId}/free/manifest.json`,
      dust: Number(expected.record.dust),
    });
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
    expect(manifest).toMatchObject({
      roundId,
      mode: 'free',
      beaconRound: round.state.beaconRound,
      entryCount: PLAYERS,
      record: {
        outcome: 'settled',
        winner: 0,
        n: expected.record.n.map(String),
        w: expected.record.w.map(String),
        dust: String(expected.record.dust),
      },
    });
    for (const c of manifest.chunks) {
      const chunk = await bundleObject(roundId, c.key.split('/').pop()!);
      expect(keccak256(chunk)).toBe(c.hash);
    }

    // Anchored write-once on the local FlockedAnchor, and the settlement records that transaction.
    const onchain = await anvil.readContract({
      address: state.contracts.anchor,
      abi: flockedAnchorAbi,
      functionName: 'getAnchor',
      args: [key],
    });
    expect(onchain.manifestHash).toBe(bundleHash);
    expect(onchain.manifestAnchoredAt).toBeGreaterThanOrEqual(BigInt(round.state.beaconTimeSec));
    const anchored = round.anchorEvents.find((e) => e.event === 'ManifestAnchored');
    expect(round.settlement?.txHash).toBe(anchored?.txHash);

    // Entries carry their outcome, ciphertexts are archived, and the RoundDO shows `settled`.
    expect(round.entries).toHaveLength(PLAYERS);
    for (const e of round.entries) {
      const p = players[e.seq]!;
      expect(e).toMatchObject({
        optionIndex: p.option,
        valid: p.option !== null,
        voidReason: p.option === null ? 'bad_option' : null,
        archived: true,
      });
    }
    expect(round.state.modes.free?.status).toBe('settled');
    expect(round.free.revealedAt).toBeGreaterThanOrEqual(beaconMs);

    // Balances: each player's global balance moved by exactly their payout.
    const byAccount = new Map<string, Payout>(expected.payouts.map((x) => [x.account, x]));
    expect(round.payouts).toHaveLength(expected.payouts.length);
    for (const p of players) {
      const payout = byAccount.get(p.entry!.receipt.userIdHash);
      expect(await globalBalance(p), `player ${p.entry!.receipt.seq}`).toBe(
        p.before! + (payout?.amount ?? 0n),
      );
    }
    expect(expected.payouts.find((x) => x.kind === 'void_refund')?.amount).toBe(players[7]!.stake);
  });
});
