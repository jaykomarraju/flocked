// A mocked world for the browser specs (W9-C): the API, the chain RPC and the round's WebSocket, all
// answered inside the page, so the app's own production bundle (the stack's `apps/web/dist`, or `vite
// preview`) runs the Free entry flow and the reveal deterministically, without a stack.
//
// - The round is a daily round on drand quicknet whose beacon is round 32,870,075, the recorded round
//   (it closes 2 minutes before that beacon, not at 21:00 New York, so the local chain skips that check)
//   in packages/tlock/fixtures/quicknet-beacons.json, so a test can open the browser's ciphertext with
//   the recorded signature (TL-1). The page clock starts an hour before close.
// - The trusted chain (`window.__FLOCKED_LOCAL_CHAIN__`, apps/web/src/crypto/chain.ts) points at a fake
//   RPC host this file answers: FlockedAnchor's lock leaf and receipt signer.
// - `POST /rounds/:id/entries` answers a receipt signed the way apps/api signs it (or `tamper`'s edit).
// - The round socket sends `state` on connect; `push` sends any later message.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flockedAnchorAbi, flockedEscrowAbi } from '@flocked/abi';
import {
  RoundViewSchema,
  freeConfigHash,
  questionHash,
  receiptTypedData,
  ulidToHex,
  type CreateEntryRequest,
  type CreateEntryResponse,
  type RoundView,
} from '@flocked/shared';
import { QUICKNET, beaconTime, commitment, fromBase64Url } from '@flocked/tlock';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TURNSTILE_TOKEN } from '../fixtures/user';

/** The recorded quicknet round and its signature (packages/tlock/fixtures/quicknet-beacons.json). */
export const RECORDED_ROUND = 32_870_075;
export const RECORDED_SIGNATURE =
  '85c653c4e0099d069e9f7f525d14239c5f2ffa496f02ad5daf4e4e240de575261d5248172ad543b351b236c838853d8e';

const SHARED_FIXTURES = join(import.meta.dirname, '../../packages/shared/test/fixtures/api');
const ME = (
  JSON.parse(readFileSync(join(SHARED_FIXTURES, 'me.json'), 'utf8')) as {
    valid: { MeResponseSchema: { user: { id: string } }[] };
  }
).valid.MeResponseSchema[0]!;

const RPC_URL = 'http://rpc.flocked.test/';
const ANCHOR: Address = '0x00000000000000000000000000000000000a1c40';
const ESCROW: Address = '0x00000000000000000000000000000000000e5c20';
const USDC: Address = '0x000000000000000000000000000000000005dc00';
const TREASURY: Address = '0x00000000000000000000000000000000000c0ffe';
/** The smart wallet the Stakes world enters from. */
const WALLET: Address = '0x00000000000000000000000000000000000a11e7';
const CHAIN_ID = 31337;
/** The round's chain ID onchain, and its fixed stake at the launch default (5 USDC). */
const CHAIN_ROUND_ID = 7n;
const STAKE = 5_000_000n;

const FREE = {
  stakeMin: '10',
  stakeMax: '100',
  presets: ['10', '25', '50', '100'],
  feeBps: 0 as const,
  creatorBps: 0 as const,
  capMultiple: 10,
  minEntrants: 1,
  creatorAwardBps: 100,
  awardRecipient: null,
};

/** The Stakes mode's locked config at the launch defaults (spec "Sealed picks" › Round config check). */
const STAKES_DEFAULTS = {
  stake: String(STAKE),
  feeBps: 500 as const,
  creatorBps: 100 as const,
  capMultiple: 10,
  minEntrants: 20,
  creator: TREASURY,
  authorHandle: null,
  payoutAddress: null,
};

/** Paper's example question as a round carries it (the question hash is taken from this). */
const QUESTION_VIEW = {
  id: '01JA0000000000000000000QST',
  prompt: 'Would you rather fight one horse-sized duck or 100 duck-sized horses?',
  options: [
    { label: 'One horse-sized duck', emoji: '' },
    { label: '100 duck-sized horses', emoji: '' },
  ] as const,
  category: 'hypothetical' as const,
  author: null,
};

/** Paper's example question (docs/design: "Would you rather fight…"). */
export const QUESTION = {
  prompt: 'Would you rather fight one horse-sized duck or 100 duck-sized horses?',
  options: ['One horse-sized duck', '100 duck-sized horses'] as const,
};

function nyGameDay(unixSec: number): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSec * 1000));
  return p;
}

export interface LockLeaf {
  closesAt: number;
  beaconRound: number;
  lockedAt: number;
  questionHash: Hex;
  configHash: Hex;
}

export interface World {
  round: RoundView;
  me: { user: { id: string } };
  /** Entries the app posted, as sent. */
  posted: CreateEntryRequest[];
  /** The lock leaf the RPC serves; edit it to make the check fail. */
  leaf: LockLeaf;
  /** Edits the entry answer before it's sent (a receipt mismatch). */
  tamper: ((r: CreateEntryResponse) => CreateEntryResponse) | null;
  /** The server's view of the player's entry (`GET /rounds/:id/me`); null before one. */
  myEntry: { stake: string; optionIndex: 0 | 1 | null } | null;
  /** Sends a message on the round socket (after the app connected). */
  push: (msg: Record<string, unknown>) => Promise<void>;
  /** Re-sends `state` at the world's server time on the open socket, if the app has one. */
  resync: () => Promise<void>;
  /** The `state` message the socket sends on connect, at the world's server time. */
  state: (over?: Record<string, unknown>) => Record<string, unknown>;
  /** Messages every new socket gets after `state` (a page loaded after the close or the reveal). */
  onConnect: Record<string, unknown>[];
  /** The server's clock, Unix seconds (`setPageTime` moves it with the page's). */
  nowSec: number;
  /** Stakes (W10-C); undefined unless `mockWorld` was asked for a Stakes round. */
  stakes?: StakesWorld;
}

/** The Stakes half of the world: eligibility, the chain's config, the wallet and the paymaster. */
export interface StakesWorld {
  /** The escrow's `RoundConfig`, as the RPC serves it; edit a field to make the check refuse. */
  config: Record<string, bigint | number | Hex>;
  /** `wallet_sendCalls` batches the app sent, newest last. */
  sent: { calls: { to: string; data: string }[]; capabilities: unknown }[];
  /** ERC-7677 requests the wallet made to the paymaster URL the app asked it to use. */
  paymasterCalls: { method: string; url: string }[];
  /** What `wallet_getCallsStatus` answers: the batch reverts instead of landing. */
  revert: boolean;
  /** `POST /rounds/:id/entries/stakes/prepare` answers this; edit it to break the ticket. */
  ticketFor: (wallet: string) => Record<string, unknown>;
  /** The wallet that enters. */
  wallet: Address;
}

/** Installs the mocked world on `page`. Call before `page.goto`. */
export async function mockWorld(
  page: Page,
  opts: {
    signedIn?: boolean;
    storedPick?: 0 | 1;
    /**
     * Stakes (W10-C): adds a Stakes mode to the round, answers `/me` with this eligibility, serves
     * the escrow's `RoundConfig` over the RPC, and installs a smart-wallet stand-in that batches
     * calls through the app's own paymaster URL.
     */
    stakes?: {
      eligible?: boolean;
      reasons?: string[];
      /** Overrides on the locked config the API publishes (a non-default round). */
      published?: Record<string, string | number>;
      /** Overrides on what the chain answers (a config mismatch). */
      onchain?: Record<string, bigint | number | string>;
    };
  } = {},
): Promise<World> {
  const signer = privateKeyToAccount(generatePrivateKey());
  const beaconDelay = 120;
  const bt = beaconTime(QUICKNET, RECORDED_ROUND);
  const closesAt = bt - beaconDelay;
  const configHash = freeConfigHash({ beaconDelay, free: FREE });
  const round = RoundViewSchema.parse({
    id: '01JA0000000000000000000RND',
    kind: 'daily',
    roomId: null,
    gameDay: nyGameDay(closesAt),
    status: 'open',
    question: {
      id: '01JA0000000000000000000QST',
      prompt: QUESTION.prompt,
      options: QUESTION.options.map((label) => ({ label, emoji: '' })),
      category: 'hypothetical',
      author: null,
    },
    opensAt: closesAt - 86_400,
    closesAt,
    beaconRound: RECORDED_ROUND,
    beaconTime: bt,
    lockedAt: (closesAt - 90_000) * 1000,
    config: {
      beaconDelay,
      free: { ...FREE, configHash },
      overrides: stakesOverrides(opts.stakes?.published),
      ...(opts.stakes
        ? {
            stakes: {
              ...STAKES_DEFAULTS,
              chainRoundId: String(CHAIN_ROUND_ID),
              opensAt: closesAt - 86_400,
              closesAt,
              beaconRound: RECORDED_ROUND,
              questionHash: questionHash(QUESTION_VIEW),
              ...opts.stakes.published,
            },
          }
        : {}),
    },
    modes: {
      free: {
        status: 'pending',
        entrantCount: 1204,
        pool: '30100',
        chainRoundId: null,
        revealedAt: null,
        claimsOpenAt: null,
        finalAt: null,
        refundReason: null,
        settlement: null,
      },
      ...(opts.stakes
        ? {
            stakes: {
              status: 'pending',
              entrantCount: 212,
              pool: '1060000000',
              chainRoundId: String(CHAIN_ROUND_ID),
              revealedAt: null,
              claimsOpenAt: null,
              finalAt: null,
              refundReason: null,
              settlement: null,
            },
          }
        : {}),
    },
  });
  const stakesConfig: StakesWorld['config'] = {
    opensAt: BigInt(closesAt - 86_400),
    closesAt: BigInt(closesAt),
    beaconRound: BigInt(RECORDED_ROUND),
    stake: STAKE,
    feeBps: STAKES_DEFAULTS.feeBps,
    creatorBps: STAKES_DEFAULTS.creatorBps,
    capMultiple: STAKES_DEFAULTS.capMultiple,
    minEntrants: STAKES_DEFAULTS.minEntrants,
    creator: TREASURY,
    questionHash: questionHash(QUESTION_VIEW),
  };
  // The published values the API serves are the chain's unless the test moves one of them.
  for (const [key, value] of Object.entries(opts.stakes?.published ?? {})) {
    if (key in stakesConfig) {
      stakesConfig[key] = typeof value === 'number' ? value : BigInt(value);
    }
  }
  for (const [key, value] of Object.entries(opts.stakes?.onchain ?? {})) {
    stakesConfig[key] =
      typeof value === 'string' && value.startsWith('0x')
        ? (value as Hex)
        : typeof value === 'number'
          ? value
          : BigInt(value);
  }
  const stakes: StakesWorld = {
    config: stakesConfig,
    sent: [],
    paymasterCalls: [],
    revert: false,
    wallet: WALLET,
    ticketFor: (wallet) => ({
      ticket: {
        roundId: String(CHAIN_ROUND_ID),
        wallet: wallet.toLowerCase(),
        personTag: `0x${'ab'.repeat(32)}`,
        expiry: closesAt + 600,
      },
      signature: `0x${'cd'.repeat(65)}`,
      chainId: CHAIN_ID,
      verifyingContract: ESCROW,
      stake: String(STAKE),
      beaconRound: RECORDED_ROUND,
    }),
  };

  let socket: WebSocketRoute | null = null;
  const world: World = {
    round,
    me: ME,
    posted: [],
    leaf: {
      closesAt,
      beaconRound: RECORDED_ROUND,
      lockedAt: closesAt - 90_000,
      questionHash: questionHash(round.question),
      configHash,
    },
    tamper: null,
    onConnect: [],
    nowSec: closesAt - 3600,
    myEntry: opts.storedPick === undefined ? null : { stake: '25', optionIndex: null },
    state: (over = {}) => ({
      type: 'state',
      roundId: round.id,
      status: 'open',
      opensAt: round.opensAt,
      closesAt: round.closesAt,
      beaconRound: round.beaconRound,
      beaconTime: round.beaconTime,
      serverTime: world.nowSec * 1000,
      modes: {
        free: {
          status: 'pending',
          entrantCount: 1204,
          pool: '30100',
          revealedAt: null,
          claimsOpenAt: null,
          refundReason: null,
          result: null,
        },
      },
      ...over,
    }),
    push: async (msg) => {
      for (let i = 0; i < 50 && !socket; i++) await page.waitForTimeout(100);
      if (!socket) throw new Error('the app never opened the round socket');
      socket.send(JSON.stringify(msg));
    },
    resync: async () => {
      if (socket) await world.push(world.state());
    },
    ...(opts.stakes ? { stakes } : {}),
  };

  await page.clock.install({ time: (closesAt - 3600) * 1000 });
  await page.addInitScript(
    ({ local, pick }) => {
      const g = globalThis as unknown as {
        localStorage: { setItem(k: string, v: string): void };
        __FLOCKED_LOCAL_CHAIN__?: unknown;
      };
      g.__FLOCKED_LOCAL_CHAIN__ = local;
      try {
        g.localStorage.setItem('flocked.onboarded', '1');
        if (pick) g.localStorage.setItem(pick.key, pick.value);
      } catch {
        // Storage blocked: the onboarding modal would show.
      }
    },
    {
      local: {
        rpcUrl: RPC_URL,
        anchor: ANCHOR,
        escrow: ESCROW,
        usdc: USDC,
        drand: QUICKNET,
        skipDailyClose: true,
      },
      pick:
        opts.storedPick === undefined
          ? null
          : {
              key: `flocked.pick.${ME.user.id}.${round.id}.free`,
              value: JSON.stringify(await storedPick(round, opts.storedPick, signer)),
            },
    },
  );
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.turnstile = { render(el, o) { setTimeout(() => o.callback(${JSON.stringify(
        TURNSTILE_TOKEN,
      )})); return "w"; }, remove() {} };`,
    }),
  );
  await page.route(RPC_URL, (route) => answerRpc(route, world, signer.address, stakes));
  if (opts.stakes) await installSmartWallet(page, stakes);
  await page.routeWebSocket(/\/api\/v1\/rounds\/[^/]+\/ws$/, (ws) => {
    socket = ws;
    ws.onMessage((m) => {
      if (m === 'ping') ws.send('pong');
    });
    ws.send(JSON.stringify(world.state()));
    for (const msg of world.onConnect) ws.send(JSON.stringify(msg));
  });
  await page.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api\/v1/, '');
    const key = `${req.method()} ${path}`;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (key === 'GET /me') {
      if (opts.signedIn === false) {
        return json(401, { error: { code: 'unauthorized', message: 'Sign in' } });
      }
      const s = opts.stakes;
      return json(
        200,
        s
          ? {
              ...ME,
              stakes: {
                eligible: s.eligible ?? true,
                reasons: s.eligible ? [] : (s.reasons ?? []),
              },
            }
          : ME,
      );
    }
    if (key === `POST /rounds/${round.id}/entries/stakes/prepare`) {
      const body = req.postDataJSON() as { wallet: string };
      return json(200, stakes.ticketFor(body.wallet));
    }
    if (key === 'POST /me/tos') {
      const tos = (ME as unknown as { tos: Record<string, unknown> }).tos;
      return json(200, { tos: { ...tos, acceptedVersion: tos.currentVersion } });
    }
    if (key === 'POST /me/personhood') {
      return json(200, { authorizeUrl: 'https://coinbase.test/oauth/authorize?state=x' });
    }
    if (key === 'GET /rounds/today') {
      return json(200, {
        round: world.round,
        previousRoundId: null,
        crowdHint: {
          free: { category: 'hypothetical', winningShare: 0.37, rounds: 30 },
          stakes: null,
        },
      });
    }
    if (key === `GET /rounds/${round.id}`) return json(200, { round: world.round });
    if (key === `GET /rounds/${round.id}/me`) {
      return json(200, myRound(world));
    }
    if (key === `POST /rounds/${round.id}/entries`) {
      const body = req.postDataJSON() as CreateEntryRequest;
      world.posted.push(body);
      const res = await signedEntry(round, body, ME.user.id, signer);
      world.myEntry = { stake: body.stake, optionIndex: null };
      return json(201, world.tamper ? world.tamper(res) : res);
    }
    return json(404, { error: { code: 'not_found', message: 'Not found' } });
  });
  return world;
}

/** `GET /rounds/:id/me` for the world's player. */
function myRound(world: World) {
  const e = world.myEntry;
  if (!e) return { roundId: world.round.id, modes: {}, cards: [] };
  return {
    roundId: world.round.id,
    modes: {
      free: {
        modeStatus: world.round.modes.free?.status ?? 'pending',
        entry: {
          id: '01JA0000000000000000000ENT',
          stake: e.stake,
          commitment: `0x${'34'.repeat(32)}`,
          createdAt: (world.round.closesAt - 3000) * 1000,
          wallet: null,
          txHash: null,
          blockNumber: null,
          logIndex: null,
          optionIndex: e.optionIndex,
          valid: null,
          voidReason: null,
        },
        receipt: null,
        inclusionProof: null,
        result: null,
        payouts: [],
        claimsOpenAt: null,
      },
    },
    cards: [],
  };
}

async function answerRpc(route: Route, world: World, signer: Address, stakes: StakesWorld) {
  const body = route.request().postDataJSON() as {
    id: number;
    method: string;
    params: [{ to: string; data: Hex }];
  };
  const reply = (result: unknown) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    });
  if (body.method !== 'eth_call') return reply(null);
  // FlockedEscrow's `getRound`, for the Stakes round config check (W10-C).
  if (body.params[0].to?.toLowerCase() === ESCROW) {
    const escrowCall = decodeFunctionData({ abi: flockedEscrowAbi, data: body.params[0].data });
    if (escrowCall.functionName !== 'getRound') return reply(null);
    return reply(
      encodeFunctionResult({
        abi: flockedEscrowAbi,
        functionName: 'getRound',
        result: {
          cfg: stakes.config,
          status: 1,
          refundReason: 0,
          winner: 0,
          entryCount: 212,
          claimsOpenAt: 0n,
          roundBalance: 0n,
          n0: 0,
          n1: 0,
          nVoid: 0,
          winClaims: 0,
          rebateClaims: 0,
          voidClaims: 0,
          refundClaims: 0,
          winPayout: 0n,
          rebatePayout: 0n,
          fee: 0n,
          creatorFee: 0n,
          dust: 0n,
          payoutRoot: `0x${'00'.repeat(32)}`,
          bundleHash: `0x${'00'.repeat(32)}`,
        } as never,
      }),
    );
  }
  const call = decodeFunctionData({ abi: flockedAnchorAbi, data: body.params[0].data });
  if (call.functionName === 'receiptSigner') {
    return reply(
      encodeFunctionResult({
        abi: flockedAnchorAbi,
        functionName: 'receiptSigner',
        result: signer,
      }),
    );
  }
  if (call.functionName === 'getAnchor') {
    const l = world.leaf;
    return reply(
      encodeFunctionResult({
        abi: flockedAnchorAbi,
        functionName: 'getAnchor',
        result: {
          closesAt: BigInt(l.closesAt),
          beaconRound: BigInt(l.beaconRound),
          lockedAt: BigInt(l.lockedAt),
          committedAt: 0n,
          questionHash: l.questionHash,
          configHash: l.configHash,
          commitmentRoot: `0x${'00'.repeat(32)}`,
          entryCount: 0,
          totalStake: 0n,
          manifestAnchoredAt: 0n,
          manifestHash: `0x${'00'.repeat(32)}`,
        } as never,
      }),
    );
  }
  return reply(null);
}

function userIdHash(roundId: string, userId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes16' }, { type: 'bytes16' }],
      [ulidToHex(roundId), ulidToHex(userId)],
    ),
  );
}

/** A receipt the way apps/api signs it, for the entry in `body`. */
async function signedEntry(
  round: RoundView,
  body: CreateEntryRequest,
  userId: string,
  signer: ReturnType<typeof privateKeyToAccount>,
): Promise<CreateEntryResponse> {
  const ct = fromBase64Url(body.ciphertext);
  if (!ct) throw new Error('the app sent a ciphertext that is not base64url');
  const message = {
    roundId: ulidToHex(round.id),
    mode: 0 as const,
    userIdHash: userIdHash(round.id, userId),
    stake: BigInt(body.stake),
    commitment: commitment(ct),
    seq: 1204,
    closesAt: BigInt(round.closesAt),
    beaconRound: BigInt(round.beaconRound),
  };
  const signature = await signer.signTypedData(
    receiptTypedData({ chainId: CHAIN_ID, verifyingContract: ANCHOR }, message),
  );
  return {
    entry: {
      id: '01JA0000000000000000000ENT',
      roundId: round.id,
      mode: 'free',
      stake: body.stake,
      commitment: message.commitment,
      createdAt: (round.closesAt - 3000) * 1000,
    },
    receipt: {
      roundId: round.id,
      mode: 'free',
      userIdHash: message.userIdHash,
      stake: body.stake,
      commitment: message.commitment,
      seq: message.seq,
      closesAt: round.closesAt,
      beaconRound: round.beaconRound,
      signature,
      signer: signer.address.toLowerCase(),
      chainId: CHAIN_ID,
      verifyingContract: ANCHOR,
    },
  };
}

/** A pick this device stored earlier (apps/web/src/crypto/picks.ts), for a world that opens on Sealed. */
async function storedPick(
  round: RoundView,
  optionIndex: 0 | 1,
  signer: ReturnType<typeof privateKeyToAccount>,
) {
  const ciphertext = 'AAAA';
  const res = await signedEntry(round, { stake: '25', ciphertext }, ME.user.id, signer);
  return {
    v: 1,
    userId: ME.user.id,
    roundId: round.id,
    mode: 'free',
    optionIndex,
    nonce: `0x${'07'.repeat(16)}`,
    stake: '25',
    entryId: res.entry.id,
    ciphertext,
    receipt: res.receipt,
    mismatches: [],
    savedAt: 1,
  };
}

/** The pick the app stored for the world's round, read from the page. */
export async function readStoredPick(
  page: Page,
  world: World,
): Promise<Record<string, unknown> | null> {
  const raw = await page.evaluate(
    (key) =>
      (
        globalThis as unknown as { localStorage: { getItem(k: string): string | null } }
      ).localStorage.getItem(key),
    `flocked.pick.${world.me.user.id}.${world.round.id}.free`,
  );
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** No serious or critical axe violations on the page, after any running animation has finished. */
export async function expectAccessible(page: Page): Promise<void> {
  await page.waitForFunction('document.getAnimations().every((a) => a.playState !== "running")');
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
  ).toEqual([]);
}

/**
 * Moves the page's (and the world's server) clock to `unixSec`, re-sends the socket's `state` at the
 * new time, and lets a 1 s tick land.
 *
 * A `state` the socket stamped before the jump can reach the page after it, and its `serverTime` then
 * leaves the page's server clock an hour behind for good (`skewMs`, apps/web/src/ws/live.ts): CI saw
 * "Unsealing in 10:00" (W9-D). Messages on one socket arrive in order, so the re-sent `state` is the
 * page's last word on the skew. (The clock keeps flowing: axe runs on the page's timers.)
 */
export async function setPageTime(page: Page, world: World, unixSec: number): Promise<void> {
  world.nowSec = unixSec;
  await page.clock.setSystemTime(unixSec * 1000);
  await world.resync();
  await page.clock.runFor(1100);
}

/**
 * A Coinbase-Smart-Wallet stand-in for the Stakes specs: it speaks EIP-5792 (`wallet_sendCalls`,
 * `wallet_getCallsStatus`) and, for every batch, asks the ERC-7677 paymaster service the app named
 * in `capabilities.paymasterService.url` — the app's own `POST /api/v1/paymaster` proxy, which
 * W10-D builds. Until then a mock in this file answers it, so the user operation is still sent the
 * way a sponsored one is, and the spec can see that the proxy was asked.
 *
 * It does not sign or broadcast anything: the batch is recorded and reported as included (or, with
 * `world.stakes.revert`, as reverted).
 */
async function installSmartWallet(page: Page, stakes: StakesWorld): Promise<void> {
  await page.route(/\/api\/v1\/paymaster$/, async (route) => {
    const body = route.request().postDataJSON() as { id: number | string; method: string };
    stakes.paymasterCalls.push({ method: body.method, url: route.request().url() });
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          paymaster: '0x0000000000000000000000000000000000000pay'.slice(0, 42),
          paymasterData: '0x',
          isFinal: true,
        },
      }),
    });
  });

  await page.exposeFunction(
    '__flockedSendCalls',
    async (batch: { calls: { to: string; data: string }[]; capabilities: unknown }) => {
      stakes.sent.push(batch);
      // The wallet is what talks to the paymaster service, so the mock does it here.
      const url = (batch.capabilities as { paymasterService?: { url?: string } } | undefined)
        ?.paymasterService?.url;
      if (url) {
        for (const method of ['pm_getPaymasterStubData', 'pm_getPaymasterData']) {
          await page.request.post(url, {
            data: { jsonrpc: '2.0', id: 1, method, params: [{}, '0x', '0x7a69', null] },
          });
        }
      }
      return `0x${stakes.sent.length.toString(16).padStart(64, '0')}`;
    },
  );
  await page.exposeFunction('__flockedCallsReverted', () => stakes.revert);

  await page.addInitScript(
    ({ address }) => {
      interface RequestArgs {
        method: string;
        params?: unknown[];
      }
      const g = globalThis as unknown as {
        ethereum?: unknown;
        __flockedSendCalls: (batch: unknown) => Promise<string>;
        __flockedCallsReverted: () => Promise<boolean>;
        addEventListener: (type: string, fn: () => void) => void;
        dispatchEvent: (event: unknown) => boolean;
        CustomEvent: new (type: string, init: { detail: unknown }) => unknown;
        crypto: { randomUUID: () => string };
      };
      const rpcError = (code: number, message: string) =>
        Object.assign(new Error(message), { code });
      const provider = {
        isFlockedTest: true,
        request: async ({ method, params = [] }: RequestArgs): Promise<unknown> => {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [address];
            case 'eth_chainId':
              return '0x7a69';
            case 'net_version':
              return '31337';
            case 'wallet_switchEthereumChain':
              return null;
            case 'wallet_getPermissions':
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }];
            case 'wallet_getCapabilities':
              return {
                '0x7a69': {
                  atomic: { status: 'supported' },
                  paymasterService: { supported: true },
                },
              };
            case 'wallet_sendCalls': {
              const p = params[0] as { calls: unknown; capabilities?: unknown };
              const id = await g.__flockedSendCalls({
                calls: p.calls,
                capabilities: p.capabilities,
              });
              return { id };
            }
            case 'wallet_getCallsStatus': {
              const reverted = await g.__flockedCallsReverted();
              return {
                version: '2.0.0',
                id: params[0] as string,
                chainId: '0x7a69',
                atomic: true,
                status: reverted ? 400 : 200,
                receipts: reverted
                  ? []
                  : [
                      {
                        status: '0x1',
                        blockHash: `0x${'11'.repeat(32)}`,
                        blockNumber: '0x1',
                        gasUsed: '0x1',
                        transactionHash: `0x${'77'.repeat(32)}`,
                        logs: [],
                      },
                    ],
              };
            }
            default:
              throw rpcError(4200, `The test wallet does not support ${method}`);
          }
        },
        on: () => provider,
        removeListener: () => provider,
      };
      g.ethereum = provider;
      const detail = Object.freeze({
        info: {
          uuid: g.crypto.randomUUID(),
          name: 'Flocked test smart wallet',
          icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/%3E',
          rdns: 'test.flocked.smartwallet',
        },
        provider,
      });
      const announce = () =>
        g.dispatchEvent(new g.CustomEvent('eip6963:announceProvider', { detail }));
      g.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { address: stakes.wallet },
  );
}

/** The `overrides` rows the API publishes for the non-default values a test asked for. */
function stakesOverrides(
  published: Record<string, string | number> | undefined,
): { field: string; value: string | number; auditId: string }[] {
  if (!published) return [];
  return Object.entries(published).map(([field, value], i) => ({
    field: `stakes.${field}`,
    value,
    auditId: `A1F${i + 3}`,
  }));
}
