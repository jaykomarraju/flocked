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
import { flockedAnchorAbi } from '@flocked/abi';
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
const CHAIN_ID = 31337;

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
}

/** Installs the mocked world on `page`. Call before `page.goto`. */
export async function mockWorld(
  page: Page,
  opts: { signedIn?: boolean; storedPick?: 0 | 1 } = {},
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
    config: { beaconDelay, free: { ...FREE, configHash }, overrides: [] },
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
    },
  });
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
      local: { rpcUrl: RPC_URL, anchor: ANCHOR, drand: QUICKNET, skipDailyClose: true },
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
  await page.route(RPC_URL, (route) => answerRpc(route, world, signer.address));
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
      return opts.signedIn === false
        ? json(401, { error: { code: 'unauthorized', message: 'Sign in' } })
        : json(200, ME);
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

async function answerRpc(route: Route, world: World, signer: Address) {
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
