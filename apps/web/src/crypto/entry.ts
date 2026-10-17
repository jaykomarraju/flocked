// The Free entry flow (spec "Client app" › Entry flow (Free) step 2; "Sealed picks"):
//   1. check the target round and its lock leaf, read through the client's own public RPC;
//   2. build the 34-byte plaintext and encrypt it with tlock, before any call that carries the pick;
//   3. POST `{stake, ciphertext}` (with a Turnstile token on the day's first entry), retrying 503s;
//   4. verify the receipt: the signer published onchain and every field against the request,
//      `commitment` = keccak256 of the client's own ciphertext;
//   5. store the plaintext pick and the receipt on the device. A receipt that fails any check is still
//      stored, with the failed fields and the server's answer, as evidence, and the caller shows it.
import {
  freeConfigHash,
  questionHash,
  receiptTypedData,
  ulidToHex,
  type CreateEntryRequest,
  type CreateEntryResponse,
  type RoundView,
} from '@flocked/shared';
import {
  checkTargetRound,
  commitment,
  encodePlaintext,
  encryptPick,
  roundRefFromUlid,
  toBase64Url,
  type TargetRoundError,
} from '@flocked/tlock';
import {
  encodeAbiParameters,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import type { AnchorReader, LockLeaf } from './anchor';
import type { ClientChain } from './chain';
import type { StoredPick } from './picks';

/** Why the client refused to encrypt. Nothing about the pick has left the device. */
export type EntryRefusal =
  | { kind: 'no_free_mode' }
  | { kind: 'stake_out_of_range' }
  | { kind: 'target_round'; reason: TargetRoundError }
  | { kind: 'config_hash' }
  | { kind: 'lock_leaf'; field: keyof LockLeaf | 'unreadable' }
  | { kind: 'chain'; message: string };

export class EntryRefused extends Error {
  constructor(readonly refusal: EntryRefusal) {
    super(`entry refused: ${refusal.kind}`);
    this.name = 'EntryRefused';
  }
}

/** keccak256(abi.encode(bytes16 roundId, bytes16 userId)), as the receipt's `userIdHash`. */
export function userIdHash(roundId: string, userId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes16' }, { type: 'bytes16' }],
      [ulidToHex(roundId), ulidToHex(userId)],
    ),
  );
}

/** The Free config hash recomputed from the published config (the served `configHash` excluded). */
export function publishedFreeConfigHash(round: RoundView): Hex | null {
  const config = round.config;
  if (!config?.free) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { configHash, ...free } = config.free;
  try {
    // The schema parse inside checks every field; anything the API added makes this refuse.
    return freeConfigHash({ beaconDelay: config.beaconDelay, free } as Parameters<
      typeof freeConfigHash
    >[0]);
  } catch {
    return null;
  }
}

/**
 * Step 1: refuses (throws `EntryRefused`) unless the round's target beacon round is right
 * (`checkTargetRound`: the first round at or after closesAt + beaconDelay, within the bounds, in the
 * future, and a daily round closing at 21:00 New York on its game day), the stake is in the locked
 * range, and the onchain lock leaf matches closesAt, beaconRound, the question and the Free config.
 */
export async function checkFreeRound(i: {
  round: RoundView;
  stake: bigint;
  chain: ClientChain;
  reader: AnchorReader;
  nowSec: number;
}): Promise<void> {
  const { round, stake, chain, reader, nowSec } = i;
  const free = round.config?.free;
  if (!round.config || !free || !round.modes.free) throw new EntryRefused({ kind: 'no_free_mode' });
  if (stake < BigInt(free.stakeMin) || stake > BigInt(free.stakeMax)) {
    throw new EntryRefused({ kind: 'stake_out_of_range' });
  }
  const target = checkTargetRound({
    chain: chain.drand,
    closesAt: round.closesAt,
    beaconDelay: round.config.beaconDelay,
    beaconRound: round.beaconRound,
    now: nowSec,
    // Daily and room rounds both close at 21:00 New York on their game day (spec "Sealed picks").
    dailyClose: chain.skipDailyClose ? undefined : { gameDay: round.gameDay },
  });
  if (!target.ok) throw new EntryRefused({ kind: 'target_round', reason: target.reason });
  const configHash = publishedFreeConfigHash(round);
  if (!configHash || configHash !== free.configHash)
    throw new EntryRefused({ kind: 'config_hash' });

  let leaf: LockLeaf;
  try {
    leaf = await reader.freeLockLeaf(round.id);
  } catch {
    throw new EntryRefused({ kind: 'lock_leaf', field: 'unreadable' });
  }
  const expected: LockLeaf = {
    lockedAt: leaf.lockedAt,
    closesAt: round.closesAt,
    beaconRound: round.beaconRound,
    questionHash: questionHash(round.question),
    configHash,
  };
  if (leaf.lockedAt === 0) throw new EntryRefused({ kind: 'lock_leaf', field: 'lockedAt' });
  for (const field of ['closesAt', 'beaconRound', 'questionHash', 'configHash'] as const) {
    if (leaf[field] !== expected[field]) throw new EntryRefused({ kind: 'lock_leaf', field });
  }
}

export interface SealedPick {
  optionIndex: 0 | 1;
  nonce: Hex;
  ciphertext: Uint8Array;
}

/** Step 2: the plaintext (version, the round's binary ULID, the option, a fresh nonce), encrypted. */
export async function sealPick(i: {
  round: RoundView;
  optionIndex: 0 | 1;
  chain: ClientChain;
  randomBytes?: (n: number) => Uint8Array;
}): Promise<SealedPick> {
  const random = i.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  const nonce = random(16);
  const plaintext = encodePlaintext({
    roundRef: roundRefFromUlid(i.round.id),
    optionIndex: i.optionIndex,
    nonce,
  });
  const ciphertext = await encryptPick(i.chain.drand, i.round.beaconRound, plaintext);
  return { optionIndex: i.optionIndex, nonce: toHex(nonce), ciphertext };
}

/**
 * Step 4: every receipt check that fails, by field name (empty when the receipt verifies). The EIP-712
 * message is rebuilt from the client's own values (its round, stake, ciphertext and user, with the
 * server's `seq`) and the domain from its own chain and anchor, so `signature` must recover to the
 * signer published onchain over exactly what the client sent.
 */
export async function receiptMismatches(i: {
  response: CreateEntryResponse;
  round: RoundView;
  stake: bigint;
  ciphertext: Uint8Array;
  userId: string;
  chain: ClientChain;
  onchainSigner: Address;
}): Promise<string[]> {
  const { response, round, stake, chain } = i;
  const { entry, receipt } = response;
  const ownCommitment = commitment(i.ciphertext);
  const ownUserIdHash = userIdHash(round.id, i.userId);
  const bad: string[] = [];
  const check = (field: string, ok: boolean) => {
    if (!ok) bad.push(field);
  };
  check('entry.roundId', entry.roundId === round.id);
  check('entry.stake', BigInt(entry.stake) === stake);
  check('entry.commitment', entry.commitment === ownCommitment);
  check('receipt.roundId', receipt.roundId === round.id);
  check('receipt.mode', receipt.mode === 'free');
  check('receipt.userIdHash', receipt.userIdHash === ownUserIdHash);
  check('receipt.stake', BigInt(receipt.stake) === stake);
  check('receipt.commitment', receipt.commitment === ownCommitment);
  check('receipt.closesAt', receipt.closesAt === round.closesAt);
  check('receipt.beaconRound', receipt.beaconRound === round.beaconRound);
  check('receipt.chainId', receipt.chainId === chain.chainId);
  check(
    'receipt.verifyingContract',
    isAddressEqual(receipt.verifyingContract as Address, chain.anchor),
  );
  check('receipt.signer', isAddressEqual(receipt.signer as Address, i.onchainSigner));
  let recovered: Address | null = null;
  try {
    recovered = await recoverTypedDataAddress({
      ...receiptTypedData(
        { chainId: chain.chainId, verifyingContract: chain.anchor },
        {
          roundId: ulidToHex(round.id),
          mode: 0,
          userIdHash: ownUserIdHash,
          stake,
          commitment: ownCommitment,
          seq: receipt.seq,
          closesAt: BigInt(round.closesAt),
          beaconRound: BigInt(round.beaconRound),
        },
      ),
      signature: receipt.signature as Hex,
    });
  } catch {
    // A malformed signature recovers nothing.
  }
  check('receipt.signature', recovered !== null && isAddressEqual(recovered, i.onchainSigner));
  return bad;
}

/** The POST, as the API client makes it; throws `ApiError` (or anything) on failure. */
export type PostEntry = (body: CreateEntryRequest) => Promise<CreateEntryResponse>;

export interface SubmitDeps {
  chain: ClientChain;
  reader: AnchorReader;
  post: PostEntry;
  /** A Turnstile token (undefined in a build without a site key). */
  turnstile: () => Promise<string | undefined>;
  /** Whether this user already passed Turnstile with an entry on this New York game day. */
  passedTurnstileToday: boolean;
  /** Retries a 503 `unavailable` answer (spec "RoundDO down"). */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  nowSec?: () => number;
  randomBytes?: (n: number) => Uint8Array;
}

/** An API error's shape, without importing the web client here. */
interface HttpLikeError {
  status: number;
  code: string;
}
function isHttpError(err: unknown): err is HttpLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as HttpLikeError).status === 'number' &&
    typeof (err as HttpLikeError).code === 'string'
  );
}

export const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

export interface SubmitResult {
  pick: StoredPick;
  /** Whether a Turnstile token was sent and accepted (the caller records the game day). */
  usedTurnstile: boolean;
}

/**
 * Steps 1–4 for one pick. Throws `EntryRefused` before anything is sent, or the POST's error (after
 * retrying 503s, and once with a Turnstile token on 403 `turnstile_failed`). Returns the record to
 * store: `mismatches` is empty when the receipt verified.
 */
export async function submitFreeEntry(
  i: { round: RoundView; optionIndex: 0 | 1; stake: bigint; userId: string },
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  await checkFreeRound({ ...i, chain: deps.chain, reader: deps.reader, nowSec: nowSec() });
  const sealed = await sealPick({ ...i, chain: deps.chain, randomBytes: deps.randomBytes });
  const body: CreateEntryRequest = {
    stake: i.stake.toString(),
    ciphertext: toBase64Url(sealed.ciphertext),
  };

  let token = deps.passedTurnstileToday ? undefined : await deps.turnstile();
  let triedTurnstile = token !== undefined;
  let attempt = 0;
  let response: CreateEntryResponse;
  for (;;) {
    try {
      response = await deps.post(token === undefined ? body : { ...body, turnstileToken: token });
      break;
    } catch (err) {
      if (!isHttpError(err)) throw err;
      if (err.status === 503 && err.code === 'unavailable' && attempt < delays.length) {
        await sleep(delays[attempt] ?? 0);
        attempt += 1;
        continue;
      }
      if (err.status === 403 && err.code === 'turnstile_failed' && !triedTurnstile) {
        triedTurnstile = true;
        token = await deps.turnstile();
        if (token !== undefined) continue;
      }
      throw err;
    }
  }

  let signer: Address | null = null;
  try {
    signer = await deps.reader.receiptSigner();
  } catch {
    // Unreadable: every signer check below fails, and the receipt is kept as evidence.
  }
  const mismatches = signer
    ? await receiptMismatches({
        response,
        round: i.round,
        stake: i.stake,
        ciphertext: sealed.ciphertext,
        userId: i.userId,
        chain: deps.chain,
        onchainSigner: signer,
      })
    : ['receipt.signer', 'receipt.signature'];
  const pick: StoredPick = {
    v: 1,
    userId: i.userId,
    roundId: i.round.id,
    mode: 'free',
    optionIndex: sealed.optionIndex,
    nonce: sealed.nonce,
    stake: i.stake.toString(),
    entryId: response.entry.id,
    ciphertext: body.ciphertext,
    receipt: response.receipt,
    mismatches,
    ...(mismatches.length ? { evidence: response } : {}),
    savedAt: Date.now(),
  };
  return { pick, usedTurnstile: token !== undefined };
}
