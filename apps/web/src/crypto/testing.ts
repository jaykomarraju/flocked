// Test harness for the Free entry flow: a locked daily round whose published config, beacon round and
// lock leaf agree, a FlockedAnchor with a receipt signer key, and a fake API that answers an entry
// with a receipt signed the way apps/api signs it. Tests change one piece to make a check fail.
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
import { QUICKNET, commitment, firstRoundAtOrAfter, fromBase64Url } from '@flocked/tlock';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { AnchorReader, LockLeaf } from './anchor';
import type { ClientChain } from './chain';
import { userIdHash } from './entry';

export const TEST_USER_ID = '01JA0000000000000000000PYR';
export const TEST_ROUND_ID = '01JA0000000000000000000RND';
export const TEST_ANCHOR: Address = '0x00000000000000000000000000000000000a1c40';

/** 21:00 New York on 2026-10-17 (EDT), Unix seconds. */
export const TEST_CLOSES_AT = Date.UTC(2026, 9, 18, 1, 0, 0) / 1000;

const FREE = {
  stakeMin: '10',
  stakeMax: '100',
  presets: ['10', '25', '50', '100'],
  feeBps: 0,
  creatorBps: 0,
  capMultiple: 10,
  minEntrants: 1,
  creatorAwardBps: 100,
  awardRecipient: null,
} as const;

/** A locked, open daily round on drand quicknet, as `GET /rounds/today` serves it. */
export function testRound(overrides: Partial<RoundView> = {}): RoundView {
  const beaconDelay = 120;
  const beaconRound = firstRoundAtOrAfter(QUICKNET, TEST_CLOSES_AT + beaconDelay);
  const configHash = freeConfigHash({ beaconDelay, free: { ...FREE, presets: [...FREE.presets] } });
  return RoundViewSchema.parse({
    id: TEST_ROUND_ID,
    kind: 'daily',
    roomId: null,
    gameDay: '2026-10-17',
    status: 'open',
    question: {
      id: '01JA0000000000000000000QST',
      prompt: 'Would you rather fight one horse-sized duck or 100 duck-sized horses?',
      options: [
        { label: 'One horse-sized duck', emoji: '' },
        { label: '100 duck-sized horses', emoji: '' },
      ],
      category: 'hypothetical',
      author: null,
    },
    opensAt: TEST_CLOSES_AT - 86_400,
    closesAt: TEST_CLOSES_AT,
    beaconRound,
    beaconTime: QUICKNET.genesis + (beaconRound - 1) * QUICKNET.period,
    lockedAt: (TEST_CLOSES_AT - 90_000) * 1000,
    config: { beaconDelay, free: { ...FREE, configHash }, overrides: [] },
    modes: {
      free: {
        status: 'pending',
        entrantCount: 0,
        pool: '0',
        chainRoundId: null,
        revealedAt: null,
        claimsOpenAt: null,
        finalAt: null,
        refundReason: null,
        settlement: null,
      },
    },
    ...overrides,
  });
}

export const TEST_ESCROW: Address = '0x00000000000000000000000000000000000e5c20';
export const TEST_USDC: Address = '0x000000000000000000000000000000000005dc00';

export const TEST_CHAIN: ClientChain = {
  chainId: 31337,
  rpcUrl: 'http://127.0.0.1:8545',
  anchor: TEST_ANCHOR,
  escrow: TEST_ESCROW,
  usdc: TEST_USDC,
  drand: QUICKNET,
};

/** The lock leaf anchored for `round` (what `getAnchor` returns). */
export function lockLeafOf(round: RoundView): LockLeaf {
  const free = round.config?.free;
  if (!free) throw new Error('no Free config');
  return {
    closesAt: round.closesAt,
    beaconRound: round.beaconRound,
    lockedAt: Math.floor((round.lockedAt ?? 0) / 1000),
    questionHash: questionHash(round.question),
    configHash: free.configHash as Hex,
  };
}

export interface Harness {
  signer: PrivateKeyAccount;
  reader: AnchorReader & { leaf: LockLeaf };
  /** What the fake API answers, per request; `tamper` edits the answer before it's returned. */
  post: (body: CreateEntryRequest) => Promise<CreateEntryResponse>;
  posted: CreateEntryRequest[];
  tamper?: (r: CreateEntryResponse) => CreateEntryResponse;
}

/** A receipt the way apps/api signs it, for the entry in `body`. */
export async function signedEntry(
  round: RoundView,
  body: CreateEntryRequest,
  signer: PrivateKeyAccount,
  opts: { userId?: string; seq?: number; chain?: ClientChain } = {},
): Promise<CreateEntryResponse> {
  const chain = opts.chain ?? TEST_CHAIN;
  const ct = fromBase64Url(body.ciphertext);
  if (!ct) throw new Error('bad ciphertext');
  const message = {
    roundId: ulidToHex(round.id),
    mode: 0 as const,
    userIdHash: userIdHash(round.id, opts.userId ?? TEST_USER_ID),
    stake: BigInt(body.stake),
    commitment: commitment(ct),
    seq: opts.seq ?? 7,
    closesAt: BigInt(round.closesAt),
    beaconRound: BigInt(round.beaconRound),
  };
  const signature = await signer.signTypedData(
    receiptTypedData({ chainId: chain.chainId, verifyingContract: chain.anchor }, message),
  );
  return {
    entry: {
      id: '01JA0000000000000000000ENT',
      roundId: round.id,
      mode: 'free',
      stake: body.stake,
      commitment: message.commitment,
      createdAt: (round.closesAt - 3600) * 1000,
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
      chainId: chain.chainId,
      verifyingContract: chain.anchor,
    },
  };
}

export function harness(round: RoundView): Harness {
  const signer = privateKeyToAccount(generatePrivateKey());
  const h: Harness = {
    signer,
    reader: {
      leaf: lockLeafOf(round),
      freeLockLeaf: () => Promise.resolve(h.reader.leaf),
      receiptSigner: () => Promise.resolve(signer.address),
    },
    posted: [],
    post: async (body) => {
      h.posted.push(body);
      const res = await signedEntry(round, body, signer);
      return h.tamper ? h.tamper(res) : res;
    },
  };
  return h;
}
