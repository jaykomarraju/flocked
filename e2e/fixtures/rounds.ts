// Round helpers the specs share (W7-D): schedule a daily-shaped round through the seam (the only
// setup step; the scheduler locks it on its next tick, the RoundDO opens and closes it), read it
// through the public API, and enter it as a player: a sealed Free pick, or a Stakes ticket from
// `/prepare` (the API's signer path) and `enter` on the escrow from the player's wallet.
import { flockedEscrowAbi } from '@flocked/abi';
import {
  CreateEntryResponseSchema,
  RoundDetailResponseSchema,
  RoundMeResponseSchema,
  RoundsTodayResponseSchema,
  StakesPrepareResponseSchema,
  type CreateEntryResponse,
  type RoundMeResponse,
  type RoundView,
} from '@flocked/shared';
import {
  encodePlaintext,
  encryptPick,
  roundRefFromChainId,
  roundRefFromUlid,
  toBase64Url,
} from '@flocked/tlock';
import { bytesToHex, type Hex, type TransactionReceipt } from 'viem';
import type { Clock } from './clock';
import type { HttpResult } from './http';
import { poll, type Stack } from './stack';
import { TURNSTILE_TOKEN, auth, type User } from './user';
import { fundStake, mined } from './wallet';

/** A pick: option 0 or 1, or null for a well-formed ciphertext with a bad option byte (VOID). */
export type Pick = 0 | 1 | null;

export interface StakesOptions {
  stake?: string;
  feeBps?: number;
  creatorBps?: number;
  capMultiple?: number;
  minEntrants?: number;
}

export interface Scheduled {
  roundId: string;
  /** Epoch ms. */
  opensAt: number;
  closesAt: number;
}

/**
 * A daily-shaped round, unlocked, through `POST /__test/rounds/scheduled`: it opens `opensInMs`
 * from now (whole seconds), stays open `openForMs`, and its beacon is `beaconDelay` s after close.
 * The scheduler's next tick (the cron driver, every 5 s) locks it: Free's lock leaf onchain and the
 * Stakes `createRound`, which must confirm before opensAt. `roomId` makes it a room round of that
 * room (W8-D), its question the room's own, so a custom room's round locks with it.
 */
export async function scheduleRound(
  stack: Stack,
  opts: {
    opensInMs?: number;
    openForMs?: number;
    beaconDelay?: number;
    free?: boolean;
    stakes?: StakesOptions;
    prompt?: string;
    roomId?: string;
  } = {},
): Promise<Scheduled> {
  const opensAt = Math.ceil(Date.now() / 1000) * 1000 + (opts.opensInMs ?? 25_000);
  const closesAt = opensAt + (opts.openForMs ?? 60_000);
  const res = await stack.seam<{ roundId: string }>('/rounds/scheduled', {
    opensAt,
    closesAt,
    beaconDelay: opts.beaconDelay ?? 60,
    ...(opts.free === false ? { free: false } : {}),
    ...(opts.stakes ? { stakes: opts.stakes } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.roomId ? { roomId: opts.roomId } : {}),
  });
  if (res.status !== 201)
    throw new Error(`schedule a round: ${res.status} ${JSON.stringify(res.body)}`);
  return { roundId: res.body.roundId, opensAt, closesAt };
}

/** `GET /rounds/:id` (public), or null before the round is locked or while it is unknown. */
export async function publicRound(
  stack: Stack,
  roundId: string,
  user?: User,
): Promise<RoundView | null> {
  const res = await stack.api(`/rounds/${roundId}`, user ? auth(user) : {});
  if (res.status === 404) return null;
  if (res.status !== 200)
    throw new Error(`GET /rounds/${roundId}: ${res.status} ${JSON.stringify(res.body)}`);
  return RoundDetailResponseSchema.parse(res.body).round;
}

/** Polls the public round until `pred` holds. */
export function waitRound(
  stack: Stack,
  roundId: string,
  what: string,
  timeoutMs: number,
  pred: (r: RoundView) => boolean,
  user?: User,
): Promise<RoundView> {
  return poll(what, timeoutMs, async () => {
    const r = await publicRound(stack, roundId, user);
    return r && pred(r) ? r : null;
  });
}

/** `GET /rounds/:id/me` for this player. */
export async function myRound(stack: Stack, roundId: string, user: User): Promise<RoundMeResponse> {
  const res = await stack.api(`/rounds/${roundId}/me`, auth(user));
  if (res.status !== 200)
    throw new Error(`GET /rounds/${roundId}/me: ${res.status} ${JSON.stringify(res.body)}`);
  return RoundMeResponseSchema.parse(res.body);
}

/** A sealed pick: tlock to `beaconRound` on the stack's drand chain. */
export async function seal(
  stack: Stack,
  roundRef: Uint8Array,
  beaconRound: number,
  pick: Pick,
): Promise<Uint8Array> {
  const pt = encodePlaintext({
    roundRef,
    optionIndex: pick ?? 0,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
  });
  if (pick === null) pt[17] = 2; // the option byte: a well-formed ciphertext, a bad pick
  return encryptPick(stack.drandChain, beaconRound, pt);
}

/**
 * `POST /rounds/:id/entries` with a sealed pick, answered as it is (a refusal included). Retried if
 * `wrangler dev` drops it: an entry is one per user and mode.
 */
export async function postFreeEntry(
  stack: Stack,
  user: User,
  round: RoundView,
  pick: Pick,
  stake = 10n,
): Promise<HttpResult> {
  const ct = await seal(stack, roundRefFromUlid(round.id), round.beaconRound, pick);
  return stack.api(`/rounds/${round.id}/entries`, {
    ...auth(user),
    idempotent: true,
    body: { stake: String(stake), ciphertext: toBase64Url(ct), turnstileToken: TURNSTILE_TOKEN },
  });
}

/**
 * A Free entry (`postFreeEntry`); a retry that finds the first attempt landed reads the entry back
 * from `/rounds/:id/me`.
 */
export async function enterFree(
  stack: Stack,
  user: User,
  round: RoundView,
  pick: Pick,
  stake = 10n,
): Promise<CreateEntryResponse | RoundMeResponse> {
  const res = await postFreeEntry(stack, user, round, pick, stake);
  if (res.status === 201) return CreateEntryResponseSchema.parse(res.body);
  const code = (res.body as { error?: { code?: string } } | null)?.error?.code;
  if (res.attempts > 1 && code === 'already_entered') return myRound(stack, round.id, user);
  throw new Error(`Free entry: ${res.status} ${JSON.stringify(res.body)}`);
}

export interface StakesEntry {
  ciphertext: Hex;
  receipt: TransactionReceipt;
}

/**
 * A Stakes entry the way a player makes one: `/prepare` (the API checks eligibility and has the
 * signer sign a ticket), MockUSDC for the stake, then `enter` on the escrow with the API's ticket.
 * `ciphertext` enters those exact bytes instead of a new sealed pick (E2E-10).
 */
export async function enterStakes(
  stack: Stack,
  clock: Clock,
  user: User,
  round: RoundView,
  pick: Pick | { ciphertext: Hex },
): Promise<StakesEntry> {
  const prepared = await stack.api(`/rounds/${round.id}/entries/stakes/prepare`, {
    ...auth(user),
    body: { wallet: user.wallet.lower },
  });
  if (prepared.status !== 200) {
    throw new Error(`Stakes prepare: ${prepared.status} ${JSON.stringify(prepared.body)}`);
  }
  const p = StakesPrepareResponseSchema.parse(prepared.body);
  const chainRoundId = BigInt(p.ticket.roundId);
  const ciphertext =
    typeof pick === 'object' && pick !== null
      ? pick.ciphertext
      : bytesToHex(await seal(stack, roundRefFromChainId(chainRoundId), p.beaconRound, pick));
  await fundStake(stack, user.wallet, BigInt(p.stake));
  // The escrow checks anvil's clock, which can trail the RoundDO's (opened on the wall clock).
  await clock.mineTo(round.opensAt);
  const receipt = await mined(
    stack,
    user.wallet.client.writeContract({
      address: stack.contracts.escrow,
      abi: flockedEscrowAbi,
      functionName: 'enter',
      args: [
        chainRoundId,
        ciphertext,
        {
          roundId: chainRoundId,
          wallet: user.wallet.address,
          personTag: p.ticket.personTag as Hex,
          expiry: BigInt(p.ticket.expiry),
        },
        p.signature as Hex,
      ],
    }),
  );
  return { ciphertext, receipt };
}

/**
 * Polls `GET /rounds/today` until it serves this round, so a browser that opens Today draws it and
 * not a round another spec left open (W10-D.2).
 */
export function waitForToday(
  stack: Stack,
  roundId: string,
  timeoutMs = 120_000,
): Promise<RoundView> {
  return poll(`GET /rounds/today to serve ${roundId}`, timeoutMs, async () => {
    const res = await stack.api('/rounds/today');
    if (res.status !== 200) return null;
    const today = RoundsTodayResponseSchema.parse(res.body);
    return today.round?.id === roundId ? today.round : null;
  });
}
