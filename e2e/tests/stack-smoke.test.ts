// Local stack smoke test (W3-D; e2e/stack/README.md): one real Free round end to end against
// `pnpm stack:up`. Two wallets sign in with SIWE, the test seam creates and locks a round on the
// local drand chain, each wallet seals a pick with @flocked/tlock and enters, and each receipt is
// checked against the signer that the local FlockedAnchor reports. The game clock then moves to
// close, the RoundDO builds the commitment root, the local beacon arrives, and the picks are opened
// both here (Node) and inside the `wrangler dev` bundle (the seam's reveal).
//
//   pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/stack-smoke.test.ts
import { flockedAnchorAbi } from '@flocked/abi';
import { freeCommitmentTree, userIdHash } from '@flocked/settle';
import {
  AuthSessionResponseSchema,
  CreateEntryResponseSchema,
  ErrorEnvelopeSchema,
  MODE_CODES,
  SiweNonceResponseSchema,
  receiptTypedData,
  ulidToBytes,
  ulidToHex,
  type CreateEntryResponse,
} from '@flocked/shared';
import {
  beaconTime,
  chainFromEnv,
  checkTargetRound,
  commitment,
  decodePlaintext,
  decryptWithSignature,
  encodePlaintext,
  encryptPick,
  roundRefFromUlid,
  toBase64Url,
  verifyBeacon,
} from '@flocked/tlock';
import { createPublicClient, getAddress, http, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDevVars, readState } from '../stack/env.mjs';

interface StackState {
  ready: boolean;
  apiUrl: string;
  appOrigin: string;
  drand: { url: string; chainHash: string; publicKey: string; genesis: number; period: number };
  anvil: { rpcUrl: string; chainId: number };
  contracts: { anchor: Hex; escrow: Hex };
  addresses: { receiptSigner: Hex };
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

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${state!.apiUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
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

async function poll<T>(what: string, timeoutMs: number, fn: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** SIWE sign-in (creating the account behind Turnstile's always-pass test secret); a Bearer token. */
async function signIn(account: PrivateKeyAccount): Promise<{ token: string; userId: string }> {
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
  const session = AuthSessionResponseSchema.parse(res.body);
  expect(session.created).toBe(true);
  return { token: session.token!, userId: session.user.id };
}

interface Player {
  token: string;
  userId: string;
  optionIndex: 0 | 1;
  ct?: Uint8Array;
  entry?: CreateEntryResponse;
}

interface LockedRound {
  roundId: string;
  opensAt: number;
  closesAt: number;
  beaconRound: number;
  beaconTimeSec: number;
  config: { beaconDelay: number };
}

describe('local stack: a Free entry end to end', () => {
  const players: Player[] = [];
  let round: LockedRound;

  beforeAll(async () => {
    for (const optionIndex of [0, 1] as const) {
      players.push({ ...(await signIn(privateKeyToAccount(generatePrivateKey()))), optionIndex });
    }
  });

  afterAll(async () => {
    await seam('/clock', { nowMs: null });
  });

  it('the seam is closed without the per-run key', async () => {
    const res = await call('/__test/clock', { body: { nowMs: null } });
    expect(res.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(res.body).error.code).toBe('not_found');
  });

  it('creates and locks a round on the local drand chain through the test seam', async () => {
    // The clock is pinned a few seconds before close, so the round stays open however long the
    // entries take; beacon time stays on the real clock, as drand runs on it.
    const t = Math.ceil(Date.now() / 1000) * 1000;
    const clock = await seam('/clock', { nowMs: t });
    expect(clock.body).toEqual({ nowMs: t });
    const res = await seam('/rounds', {
      opensAt: t - 60_000,
      closesAt: t + 6_000,
      beaconDelay: 60,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    round = (res.body as { locked: LockedRound }).locked;
    expect((res.body as { state: { status: string } }).state.status).toBe('open');
    expect(round.beaconTimeSec).toBe(beaconTime(chain, round.beaconRound));
    expect(
      checkTargetRound({
        chain,
        closesAt: round.closesAt / 1000,
        beaconDelay: round.config.beaconDelay,
        beaconRound: round.beaconRound,
        now: t / 1000,
      }),
    ).toEqual({ ok: true });
  });

  it('keeps the round open on the pinned game clock after closesAt passes on the wall clock', async () => {
    // Proves FLOCKED_TEST_CLOCK reaches the RoundDO: on wall time the round would now be closed.
    await sleep(Math.max(0, round.closesAt + 1_000 - Date.now()));
    const res = await seam(`/rounds/${round.roundId}`);
    expect((res.body as { status: string; state: { status: string } }).status).toBe('open');
    expect((res.body as { state: { status: string } }).state.status).toBe('open');
  });

  it('accepts a sealed pick from each player and signs receipts the FlockedAnchor accepts', async () => {
    const onchainSigner = await anvil.readContract({
      address: state.contracts.anchor,
      abi: flockedAnchorAbi,
      functionName: 'receiptSigner',
    });
    expect(onchainSigner).toBe(getAddress(state.addresses.receiptSigner));

    for (const p of players) {
      const pt = encodePlaintext({
        roundRef: roundRefFromUlid(round.roundId),
        optionIndex: p.optionIndex,
        nonce: crypto.getRandomValues(new Uint8Array(16)),
      });
      p.ct = await encryptPick(chain, round.beaconRound, pt);
      const res = await call(`/api/v1/rounds/${round.roundId}/entries`, {
        token: p.token,
        body: { stake: '10', ciphertext: toBase64Url(p.ct) },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      p.entry = CreateEntryResponseSchema.parse(res.body);
      const r = p.entry.receipt;

      expect(r).toMatchObject({
        roundId: round.roundId,
        stake: '10',
        commitment: commitment(p.ct),
        closesAt: round.closesAt / 1000,
        beaconRound: round.beaconRound,
        chainId: state.anvil.chainId,
      });
      expect(r.userIdHash).toBe(userIdHash(ulidToBytes(round.roundId), ulidToBytes(p.userId)));
      expect(getAddress(r.verifyingContract)).toBe(getAddress(state.contracts.anchor));
      expect(getAddress(r.signer)).toBe(onchainSigner);

      const message = {
        roundId: ulidToHex(r.roundId),
        mode: MODE_CODES.free,
        userIdHash: r.userIdHash as Hex,
        stake: BigInt(r.stake),
        commitment: r.commitment as Hex,
        seq: r.seq,
        closesAt: BigInt(r.closesAt),
        beaconRound: BigInt(r.beaconRound),
      };
      const valid = await anvil.readContract({
        address: state.contracts.anchor,
        abi: flockedAnchorAbi,
        functionName: 'verifyReceipt',
        args: [message, r.signature as Hex],
      });
      expect(valid).toBe(true);
      // The shared typed data (what clients verify with) recovers the same signer.
      const recovered = await recoverTypedDataAddress({
        ...receiptTypedData(
          { chainId: r.chainId, verifyingContract: r.verifyingContract as Hex },
          message,
        ),
        signature: r.signature as Hex,
      });
      expect(recovered).toBe(onchainSigner);
    }
    expect(players.map((p) => p.entry!.receipt.seq).sort()).toEqual([0, 1]);
  });

  it('closes when the game clock reaches closesAt and commits every receipt in the root', async () => {
    await seam('/clock', { nowMs: round.closesAt });

    const late = await call(`/api/v1/rounds/${round.roundId}/entries`, {
      token: players[0]!.token,
      body: { stake: '10', ciphertext: toBase64Url(players[1]!.ct!) },
    });
    expect(ErrorEnvelopeSchema.parse(late.body).error.code).toBe('round_closed');

    // The RoundDO's alarm re-arms every (closesAt − pinned clock) = 6 s on wall time.
    const closed = await poll('the round to close', 30_000, async () => {
      const res = await seam(`/rounds/${round.roundId}`);
      const body = res.body as { status: string; free: { commitmentRoot: string | null } };
      return body.status === 'closed' && body.free.commitmentRoot ? body : null;
    });
    const tree = freeCommitmentTree(
      players.map((p) => ({
        roundId: ulidToBytes(round.roundId),
        mode: MODE_CODES.free,
        userIdHash: p.entry!.receipt.userIdHash as Hex,
        stake: BigInt(p.entry!.receipt.stake),
        commitment: p.entry!.receipt.commitment as Hex,
        seq: p.entry!.receipt.seq,
      })),
    );
    expect(closed.free.commitmentRoot).toBe(tree.root);
  });

  it('opens every pick with the local beacon, in Node and in the wrangler dev bundle', async () => {
    const waitMs = round.beaconTimeSec * 1000 - Date.now() + 30_000;
    const beacon = await poll('the local beacon', waitMs, async () => {
      const res = await fetch(`${state.drand.url}/public/${round.beaconRound}`);
      return res.ok ? ((await res.json()) as { round: number; signature: string }) : null;
    });
    expect(beacon.round).toBe(round.beaconRound);
    expect(verifyBeacon(chain, round.beaconRound, beacon.signature)).toBe(true);

    for (const p of players) {
      const pt = decodePlaintext(await decryptWithSignature(chain, p.ct!, beacon.signature));
      expect(pt?.optionIndex).toBe(p.optionIndex);
      expect(pt?.roundRef).toEqual(roundRefFromUlid(round.roundId));
    }

    const res = await seam(`/rounds/${round.roundId}/reveal`, { signature: beacon.signature });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const opened = (
      res.body as {
        entries: { id: string; valid: boolean; optionIndex: number; decryptedOption: number }[];
      }
    ).entries;
    expect(opened).toEqual(
      players.map((p) => ({
        id: p.entry!.entry.id,
        valid: true,
        optionIndex: p.optionIndex,
        decryptedOption: p.optionIndex,
      })),
    );
  });
});
