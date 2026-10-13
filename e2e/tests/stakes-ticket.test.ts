// Stakes entry tickets on the local stack (W6-B, W6-D; spec "Identity and personhood" › Entry
// tickets (Stakes); NFR-7).
//
// First, the signing code: the operator creates a Stakes round on anvil, a fresh player funds and
// approves the stake, and apps/signer's `signTicket` signs the ticket with the escrow's ticket-signer
// key (`e2e/stack/.run/ticket-signer.dev.vars`, written by `stack:up`, never in the API's `.dev.vars`)
// against an in-memory ticket record. The escrow's own `ticketDigest` equals the hash the API would
// record, `enter` accepts the ticket, and `Entered` carries it; a ticket signed by any other key
// reverts.
//
// Then the deployed path: the stack runs apps/signer beside the API, behind the API's `SIGNER`
// service binding. A player signs in, verifies with the Coinbase and EAS mocks and accepts the
// Terms; the scheduler locks a Stakes-only round and creates it onchain; and
// `POST /rounds/:id/entries/stakes/prepare` records the ticket and has the signer sign it. The
// signature is the escrow's ticket signer's (a key the API doesn't hold), `enter` accepts it, and the
// indexer files the entry under the player through the ticket the API recorded. The stack seeds
// `mode.stakes.enabled` and `geo.stakes.allow` (["US"], wrangler's placeholder request location).
// The round closes a day later, so it stays open through the steps after this one.
//
//   pnpm stack:up && pnpm --filter @flocked/e2e exec vitest run tests/stakes-ticket.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';
import {
  AuthSessionResponseSchema,
  MeResponseSchema,
  PersonhoodCallbackResponseSchema,
  SiweNonceResponseSchema,
  StakesPrepareResponseSchema,
  StartPersonhoodResponseSchema,
  ticketDigest,
} from '@flocked/shared';
import { chainFromEnv, encodePlaintext, encryptPick, roundRefFromChainId } from '@flocked/tlock';
import {
  BaseError,
  ContractFunctionRevertedError,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
  recoverAddress,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, RUN_DIR, readDevVars, readState } from '../stack/env.mjs';

interface StackState {
  ready: boolean;
  apiUrl: string;
  appOrigin: string;
  coinbaseUrl: string;
  easUrl: string;
  drand: { chainHash: string; publicKey: string; genesis: number; period: number };
  anvil: { rpcUrl: string; chainId: number };
}

const state = readState() as StackState | null;
const vars = readDevVars() as Record<string, string> | null;
if (!state?.ready || !vars) throw new Error('the local stack is not up: run `pnpm stack:up` first');

/** The signer's key file (dotenv, one line). */
function ticketSignerKey(): Hex {
  const text = readFileSync(join(RUN_DIR, 'ticket-signer.dev.vars'), 'utf8');
  const m = /^TICKET_SIGNER_KEY='?(0x[0-9a-fA-F]{64})'?$/m.exec(text);
  if (!m?.[1]) throw new Error('ticket-signer.dev.vars has no TICKET_SIGNER_KEY');
  return m[1] as Hex;
}

// --- apps/signer's signing code (loaded at runtime; e2e doesn't typecheck apps/signer) -------------

interface SignTicketRequest {
  roundId: string;
  wallet: Address;
  personTag: Hex;
  expiry: number;
  ticketHash: Hex;
}
interface TicketRow {
  ticketHash: string;
  personTag: string;
  wallet: string;
  expiry: number;
  chainRoundId: string | null;
}
interface SignerModule {
  signTicket(
    deps: {
      store: {
        ticket: (hash: string) => Promise<TicketRow | null>;
        stakesEnabled: () => Promise<boolean>;
      };
      key: Hex;
      escrow: { chainId: number; verifyingContract: Address };
      nowSec: number;
    },
    req: SignTicketRequest,
  ): Promise<{ signature: Hex }>;
  signerKey(env: { TICKET_SIGNER_KEY?: string }): Hex;
  escrowTarget(env: { CHAIN_ID: string; LOCAL_DEPLOYMENT?: string }): {
    chainId: number;
    verifyingContract: Address;
  };
}

const loadSigner = async (): Promise<SignerModule> =>
  (await import(/* @vite-ignore */ join(ROOT, 'apps', 'signer', 'src', 'sign.ts'))) as SignerModule;

// --- Chain -----------------------------------------------------------------------------------------

const rpcUrl = state.anvil.rpcUrl;
const deployment = JSON.parse(vars.LOCAL_DEPLOYMENT!) as { escrow: Address; usdc: Address };
const client = createPublicClient({
  chain: foundry,
  transport: http(rpcUrl),
  pollingInterval: 200,
});
const operator = createWalletClient({
  account: privateKeyToAccount(vars.OPERATOR_KEY as Hex),
  chain: foundry,
  transport: http(rpcUrl),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STAKE = 5_000_000n;

async function anvil(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Chain time: anvil mines no empty blocks, so its head lags wall time between transactions. */
async function chainNow(): Promise<number> {
  const head = await client.getBlock({ blockTag: 'latest' });
  return Math.max(Number(head.timestamp), Math.floor(Date.now() / 1000));
}

/** The revert's custom error name, or null if the call succeeds. */
async function revertOf(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (err) {
    if (err instanceof BaseError) {
      const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError) {
        return reverted.data?.errorName ?? reverted.reason ?? 'reverted';
      }
    }
    throw err;
  }
}

describe('a ticket from the ticket signer verifies in FlockedEscrow.enter', () => {
  let signer: SignerModule;
  let roundId: bigint;
  let opensAt: number;
  const player = privateKeyToAccount(generatePrivateKey());
  const playerWallet = createWalletClient({
    account: player,
    chain: foundry,
    transport: http(rpcUrl),
  });

  beforeAll(async () => {
    signer = await loadSigner();

    // A Stakes round, opening shortly (createRound needs opensAt in the future).
    const now = await chainNow();
    opensAt = now + 8;
    const closesAt = opensAt + 600;
    const { genesis, period } = state.drand;
    const beaconRound = BigInt(Math.ceil((closesAt + 60 - genesis) / period) + 1);
    const hash = await operator.writeContract({
      address: deployment.escrow,
      abi: flockedEscrowAbi,
      functionName: 'createRound',
      args: [
        {
          opensAt: BigInt(opensAt),
          closesAt: BigInt(closesAt),
          beaconRound,
          stake: STAKE,
          feeBps: 500,
          creatorBps: 100,
          capMultiple: 10,
          minEntrants: 20,
          creator: '0x000000000000000000000000000000000000dEaD',
          questionHash: keccak256(toHex('stakes-ticket e2e')),
        },
      ],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const [created] = parseEventLogs({
      abi: flockedEscrowAbi,
      eventName: 'RoundCreated',
      logs: receipt.logs,
    });
    roundId = created!.args.roundId;

    // The player: gas, the stake in MockUSDC, and the escrow's allowance.
    await anvil('anvil_setBalance', [player.address, toHex(10n ** 18n)]);
    for (const tx of [
      await playerWallet.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: 'mint',
        args: [player.address, STAKE],
      }),
      await playerWallet.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: 'approve',
        args: [deployment.escrow, STAKE],
      }),
    ]) {
      expect((await client.waitForTransactionReceipt({ hash: tx })).status).toBe('success');
    }
    while (Math.floor(Date.now() / 1000) <= opensAt) await sleep(500);
    // anvil mines no empty blocks: mine one so calls run in a block stamped after opensAt.
    await anvil('evm_mine');
  });

  /** A ticket for the player, recorded in an in-memory stakes_tickets and signed by `key`. */
  async function signedTicket(key: Hex, personTag: Hex = generatePrivateKey()) {
    const escrow = signer.escrowTarget({
      CHAIN_ID: '31337',
      LOCAL_DEPLOYMENT: vars!.LOCAL_DEPLOYMENT,
    });
    const ticket = {
      roundId,
      wallet: player.address,
      personTag,
      expiry: BigInt((await chainNow()) + 300),
    };
    // What apps/api records as stakes_tickets.ticket_hash.
    const ticketHash = ticketDigest(escrow, {
      ...ticket,
      wallet: player.address.toLowerCase() as Address,
    }).toLowerCase() as Hex;
    const row: TicketRow = {
      ticketHash,
      personTag,
      wallet: player.address.toLowerCase(),
      expiry: Number(ticket.expiry),
      chainRoundId: roundId.toString(),
    };
    const { signature } = await signer.signTicket(
      {
        store: {
          ticket: (h) => Promise.resolve(h === ticketHash ? row : null),
          stakesEnabled: () => Promise.resolve(true),
        },
        key,
        escrow,
        nowSec: await chainNow(),
      },
      {
        roundId: roundId.toString(),
        wallet: player.address.toLowerCase() as Address,
        personTag,
        expiry: Number(ticket.expiry),
        ticketHash,
      },
    );
    return { ticket, ticketHash, signature };
  }

  const ciphertext = toHex(new Uint8Array(96).fill(7));

  it('the escrow trusts the stack key, and the API holds no copy of it (NFR-7)', async () => {
    const key = signer.signerKey({ TICKET_SIGNER_KEY: ticketSignerKey() });
    const onchain = await client.readContract({
      address: deployment.escrow,
      abi: flockedEscrowAbi,
      functionName: 'ticketSigner',
    });
    expect(onchain).toBe(privateKeyToAccount(key).address);
    expect(Object.keys(vars)).not.toContain('TICKET_SIGNER_KEY');
    expect(Object.values(vars)).not.toContain(key);
  });

  it('a ticket signed by another key reverts with InvalidTicketSignature', async () => {
    const forged = await signedTicket(generatePrivateKey());
    expect(
      await revertOf(() =>
        client.simulateContract({
          account: player,
          address: deployment.escrow,
          abi: flockedEscrowAbi,
          functionName: 'enter',
          args: [roundId, ciphertext, forged.ticket, forged.signature],
        }),
      ),
    ).toBe('InvalidTicketSignature');
  });

  it('enter accepts the signer’s ticket, and Entered carries its hash and person tag', async () => {
    const { ticket, ticketHash, signature } = await signedTicket(ticketSignerKey());
    // The escrow's digest is the hash the API records and the signer signs.
    const onchainDigest = await client.readContract({
      address: deployment.escrow,
      abi: flockedEscrowAbi,
      functionName: 'ticketDigest',
      args: [ticket],
    });
    expect(onchainDigest.toLowerCase()).toBe(ticketHash);

    const hash = await playerWallet.writeContract({
      address: deployment.escrow,
      abi: flockedEscrowAbi,
      functionName: 'enter',
      args: [roundId, ciphertext, ticket, signature],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const [entered] = parseEventLogs({
      abi: flockedEscrowAbi,
      eventName: 'Entered',
      logs: receipt.logs,
    });
    expect(entered?.args.roundId).toBe(roundId);
    expect(entered?.args.player).toBe(player.address);
    expect(entered?.args.personTag).toBe(ticket.personTag);
    expect(entered?.args.ticketHash.toLowerCase()).toBe(ticketHash);
    expect(
      await client.readContract({
        address: deployment.escrow,
        abi: flockedEscrowAbi,
        functionName: 'hasEntered',
        args: [roundId, player.address],
      }),
    ).toBe(true);
  });
});

// --- The API, its SIGNER binding and the signer Worker on the stack (W6-D) -------------------------

interface SeamRound {
  status: string;
  state: { status: string; beaconRound: number };
  stakes: {
    status: string;
    chainRoundId: string | null;
    entries: { userId: string | null; wallet: string; foreign: boolean }[];
  } | null;
}

async function call(
  url: string,
  init: { method?: string; body?: unknown; token?: string; accept?: string } = {},
) {
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(init.accept ? { accept: init.accept } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    location: res.headers.get('location'),
    body: (text ? JSON.parse(text) : null) as unknown,
  };
}

const api = (path: string, init: { body?: unknown; token?: string } = {}) =>
  call(`${state.apiUrl}/api/v1${path}`, init);
const seam = (path: string, body?: unknown) =>
  call(`${state.apiUrl}/__test${path}`, { body, token: vars.FLOCKED_TEST_SEAM_KEY });

async function poll<T>(what: string, timeoutMs: number, fn: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** SIWE sign-in (a new account behind Turnstile's always-pass test secret); a Bearer token. */
const signIn = async (account: PrivateKeyAccount): Promise<{ token: string; userId: string }> => {
  const nonce = SiweNonceResponseSchema.parse((await api('/auth/siwe/nonce', { body: {} })).body);
  const origin = new URL(state.appOrigin);
  const message = createSiweMessage({
    address: account.address,
    chainId: state.anvil.chainId,
    domain: origin.host,
    nonce: nonce.nonce,
    uri: origin.origin,
    version: '1',
    issuedAt: new Date(),
  });
  const res = await api('/auth/siwe/verify', {
    body: {
      message,
      signature: await account.signMessage({ message }),
      turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
      transport: 'bearer',
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const session = AuthSessionResponseSchema.parse(res.body);
  return { token: session.token!, userId: session.user.id };
};

describe('the API has the ticket signer sign through its SIGNER binding', () => {
  const player = privateKeyToAccount(generatePrivateKey());
  const wallet = player.address.toLowerCase() as Address;
  const playerWallet = createWalletClient({
    account: player,
    chain: foundry,
    transport: http(rpcUrl),
  });
  let token: string;
  let userId: string;
  let roundId: string;
  let opensAt: number;
  let round: SeamRound;

  const readRound = async (): Promise<SeamRound | null> => {
    const res = await seam(`/rounds/${roundId}`);
    return res.status === 200 ? (res.body as SeamRound) : null;
  };

  beforeAll(async () => {
    // Wall time for the Worker and every DO (another test may have pinned the clock).
    await seam('/clock', { nowMs: null });
  });
  afterAll(async () => {
    await seam('/clock', { nowMs: null });
  });

  it('a verified player and an open Stakes round', async () => {
    // The round first: the scheduler's next tick locks it and creates it onchain.
    opensAt = Math.ceil(Date.now() / 1000) * 1000 + 20_000;
    const scheduled = await seam('/rounds/scheduled', {
      opensAt,
      // Open for a day, past every later stack step's clock moves (stakes-settle's is 2 h).
      closesAt: opensAt + 24 * 3600 * 1000,
      free: false,
      stakes: { stake: String(STAKE) },
    });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
    roundId = (scheduled.body as { roundId: string }).roundId;

    ({ token, userId } = await signIn(player));
    // Personhood through the Coinbase mock, as a fresh Coinbase account (one person, one account).
    const mockUser = `stakes-ticket-${Date.now()}`;
    const added = await call(`${state.coinbaseUrl}/mock/users`, {
      body: { key: mockUser, country: 'US', state: 'NJ' },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const started = StartPersonhoodResponseSchema.parse(
      (await api('/me/personhood', { body: {}, token })).body,
    );
    const authorize = new URL(started.authorizeUrl);
    authorize.searchParams.set('mock_user', mockUser);
    const approved = await call(authorize.toString());
    expect(approved.status).toBe(302);
    const callback = new URL(approved.location!);
    const outcome = await call(`${state.apiUrl}${callback.pathname}${callback.search}`, {
      token,
      accept: 'application/json',
    });
    expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
    expect(PersonhoodCallbackResponseSchema.parse(outcome.body)).toMatchObject({
      status: 'verified',
      country: 'US',
    });
    // Coinbase Verifications for the signed-in wallet, then the Terms with the age checkbox.
    const attested = await call(`${state.easUrl}/mock/verify`, {
      body: { recipient: wallet, country: 'US' },
    });
    expect(attested.status, JSON.stringify(attested.body)).toBe(200);
    // The age the checkbox names (W7-B: 18 | 21), as GET /me gives it for this player.
    const { ageRequired } = MeResponseSchema.parse((await api('/me', { token })).body).tos;
    const tos = await api('/me/tos', {
      body: { tosVersion: vars.TOS_VERSION, ageAttested: ageRequired },
      token,
    });
    expect(tos.status, JSON.stringify(tos.body)).toBe(200);
    const me = MeResponseSchema.parse((await api('/me', { token })).body);
    expect(me.stakes).toEqual({ eligible: true, reasons: [] });

    round = await poll('the round to open with its escrow round', 60_000, async () => {
      const r = await readRound();
      return r?.state.status === 'open' && r.stakes?.chainRoundId ? r : null;
    });
    expect(round.stakes?.status).toBe('pending');
  });

  it('prepare returns a ticket signed by the escrow’s ticket signer, and enter accepts it', async () => {
    const prepared = await api(`/rounds/${roundId}/entries/stakes/prepare`, {
      body: { wallet },
      token,
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const body = StakesPrepareResponseSchema.parse(prepared.body);
    const chainRoundId = BigInt(round.stakes!.chainRoundId!);
    expect(body.ticket).toMatchObject({ roundId: String(chainRoundId), wallet });
    expect(body.verifyingContract).toBe(deployment.escrow.toLowerCase());
    const ticket = {
      roundId: chainRoundId,
      wallet: player.address,
      personTag: body.ticket.personTag as Hex,
      expiry: BigInt(body.ticket.expiry),
    };
    // Only the signer Worker holds this key: the signature came through SIGNER.
    const [digest, ticketSigner] = await Promise.all([
      client.readContract({
        address: deployment.escrow,
        abi: flockedEscrowAbi,
        functionName: 'ticketDigest',
        args: [ticket],
      }),
      client.readContract({
        address: deployment.escrow,
        abi: flockedEscrowAbi,
        functionName: 'ticketSigner',
      }),
    ]);
    expect(await recoverAddress({ hash: digest, signature: body.signature as Hex })).toBe(
      ticketSigner,
    );

    // Funds, a sealed pick for the round's beacon, and `enter` with the API's ticket.
    await anvil('anvil_setBalance', [player.address, toHex(10n ** 18n)]);
    for (const tx of [
      await playerWallet.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: 'mint',
        args: [player.address, STAKE],
      }),
      await playerWallet.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: 'approve',
        args: [deployment.escrow, STAKE],
      }),
    ]) {
      expect((await client.waitForTransactionReceipt({ hash: tx })).status).toBe('success');
    }
    const chain = chainFromEnv({
      DRAND_CHAIN_HASH: state.drand.chainHash,
      DRAND_PUBLIC_KEY: state.drand.publicKey,
      DRAND_GENESIS: String(state.drand.genesis),
      DRAND_PERIOD: String(state.drand.period),
    });
    const sealed = await encryptPick(
      chain,
      body.beaconRound,
      encodePlaintext({
        roundRef: roundRefFromChainId(chainRoundId),
        optionIndex: 0,
        nonce: crypto.getRandomValues(new Uint8Array(16)),
      }),
    );
    // The RoundDO opened on the wall clock; the escrow checks anvil's, which can trail it (an
    // evm_revert sets it back to the reverted-to block's time). Mine until a block reaches opensAt.
    await poll('a block at or after opensAt', 30_000, async () => {
      await anvil('evm_mine');
      const head = await client.getBlock({ blockTag: 'latest' });
      return head.timestamp >= BigInt(opensAt / 1000) ? true : null;
    });
    const hash = await playerWallet.writeContract({
      address: deployment.escrow,
      abi: flockedEscrowAbi,
      functionName: 'enter',
      args: [chainRoundId, bytesToHex(sealed), ticket, body.signature as Hex],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const [entered] = parseEventLogs({
      abi: flockedEscrowAbi,
      eventName: 'Entered',
      logs: receipt.logs,
    });
    expect(entered?.args.ticketHash).toBe(digest);

    // The indexer files the entry under the player through the ticket row the API recorded.
    const filed = await poll('the indexer to store the entry', 60_000, async () => {
      const r = await readRound();
      return r?.stakes?.entries.find((e) => e.wallet === wallet) ?? null;
    });
    expect(filed).toMatchObject({ userId, foreign: false });
  });
});
