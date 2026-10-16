// @vitest-environment node
// (noble checks `instanceof Uint8Array`, which jsdom's realm fails; the browser half is e2e/ui/tlock-bundle.spec.ts.)
import {
  QUICKNET,
  decodePlaintext,
  decryptWithSignature,
  fromBase64Url,
  isCanonicalHeader,
} from '@flocked/tlock';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import {
  EntryRefused,
  receiptMismatches,
  sealPick,
  submitFreeEntry,
  type SubmitDeps,
} from './entry';
import {
  TEST_CHAIN,
  TEST_CLOSES_AT,
  TEST_USER_ID,
  harness,
  signedEntry,
  testRound,
  type Harness,
} from './testing';

const NOW = TEST_CLOSES_AT - 3600;

function deps(h: Harness, over: Partial<SubmitDeps> = {}): SubmitDeps {
  return {
    chain: TEST_CHAIN,
    reader: h.reader,
    post: h.post,
    turnstile: () => Promise.resolve('turnstile-token'),
    passedTurnstileToday: true,
    sleep: () => Promise.resolve(),
    nowSec: () => NOW,
    ...over,
  };
}

const ENTRY = { optionIndex: 1 as const, stake: 25n, userId: TEST_USER_ID };

async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EntryRefused);
  return (err as EntryRefused).refusal;
}

describe('submitFreeEntry', () => {
  it('checks the round, encrypts, posts and verifies the receipt', async () => {
    const round = testRound();
    const h = harness(round);
    const { pick, usedTurnstile } = await submitFreeEntry({ round, ...ENTRY }, deps(h));
    expect(pick.mismatches).toEqual([]);
    expect(pick.evidence).toBeUndefined();
    expect(usedTurnstile).toBe(false);
    expect(pick).toMatchObject({
      roundId: round.id,
      userId: TEST_USER_ID,
      optionIndex: 1,
      stake: '25',
    });
    expect(h.posted).toHaveLength(1);
    const body = h.posted[0];
    expect(body).toEqual({ stake: '25', ciphertext: pick.ciphertext });
    // The ciphertext targets the round's beacon on the client's own drand chain.
    const ct = fromBase64Url(pick.ciphertext);
    expect(ct && isCanonicalHeader(ct, QUICKNET, round.beaconRound)).toBe(true);
    // The plaintext (round, option, nonce) never leaves the device: the request is stake and ciphertext.
    expect(Object.keys(body ?? {})).toEqual(['stake', 'ciphertext']);
  });

  it.each([
    [
      'a beacon round that is not the first after close + delay',
      { beaconRound: 1 },
      'target_round',
    ],
    ['a beacon already in the past', {}, 'target_round', TEST_CLOSES_AT + 600],
    ['a close that is not 21:00 New York', { gameDay: '2026-10-16' }, 'target_round'],
  ] as const)('refuses %s before sending anything', async (_name, over, kind, now?: number) => {
    const round = testRound(over);
    const h = harness(testRound());
    const r = await refusal(
      submitFreeEntry({ round, ...ENTRY }, deps(h, { nowSec: () => now ?? NOW })),
    );
    expect(r.kind).toBe(kind);
    expect(h.posted).toHaveLength(0);
  });

  it.each(['closesAt', 'beaconRound', 'questionHash', 'configHash', 'lockedAt'] as const)(
    'refuses when the onchain lock leaf has another %s',
    async (field) => {
      const round = testRound();
      const h = harness(round);
      const leaf = h.reader.leaf;
      h.reader.leaf =
        field === 'questionHash' || field === 'configHash'
          ? { ...leaf, [field]: `0x${'ab'.repeat(32)}` }
          : field === 'lockedAt'
            ? { ...leaf, lockedAt: 0 }
            : { ...leaf, [field]: leaf[field] + 1 };
      const r = await refusal(submitFreeEntry({ round, ...ENTRY }, deps(h)));
      expect(r).toEqual({ kind: 'lock_leaf', field });
      expect(h.posted).toHaveLength(0);
    },
  );

  it('refuses when the lock leaf cannot be read', async () => {
    const round = testRound();
    const h = harness(round);
    h.reader.freeLockLeaf = () => Promise.reject(new Error('rpc down'));
    expect(await refusal(submitFreeEntry({ round, ...ENTRY }, deps(h)))).toEqual({
      kind: 'lock_leaf',
      field: 'unreadable',
    });
  });

  it('refuses a served config hash that does not match the published config', async () => {
    const round = testRound();
    const h = harness(round);
    const free = round.config?.free;
    if (!round.config || !free) throw new Error('no config');
    const tampered = { ...round, config: { ...round.config, free: { ...free, stakeMax: '1000' } } };
    expect((await refusal(submitFreeEntry({ round: tampered, ...ENTRY }, deps(h)))).kind).toBe(
      'config_hash',
    );
  });

  it('refuses a stake outside the locked range', async () => {
    const round = testRound();
    const h = harness(round);
    const r = await refusal(submitFreeEntry({ round, ...ENTRY, stake: 101n }, deps(h)));
    expect(r.kind).toBe('stake_out_of_range');
  });

  it('retries 503 unavailable, then sends a Turnstile token after 403 turnstile_failed', async () => {
    const round = testRound();
    const h = harness(round);
    const answers = [
      { status: 503, code: 'unavailable' },
      { status: 403, code: 'turnstile_failed' },
    ];
    const post = vi.fn((body: Parameters<Harness['post']>[0]) => {
      const err = answers.shift();
      return err ? Promise.reject(Object.assign(new Error(err.code), err)) : h.post(body);
    });
    const sleep = vi.fn(() => Promise.resolve());
    const { usedTurnstile } = await submitFreeEntry({ round, ...ENTRY }, deps(h, { post, sleep }));
    expect(post).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(h.posted[0]?.turnstileToken).toBe('turnstile-token');
    expect(usedTurnstile).toBe(true);
  });

  it("sends a Turnstile token with the game day's first entry", async () => {
    const round = testRound();
    const h = harness(round);
    await submitFreeEntry({ round, ...ENTRY }, deps(h, { passedTurnstileToday: false }));
    expect(h.posted[0]?.turnstileToken).toBe('turnstile-token');
  });

  it('gives up after the 503 retries and on other errors', async () => {
    const round = testRound();
    const h = harness(round);
    const post = vi.fn(() =>
      Promise.reject(Object.assign(new Error('x'), { status: 503, code: 'unavailable' })),
    );
    await expect(
      submitFreeEntry({ round, ...ENTRY }, deps(h, { post, retryDelaysMs: [1, 1] })),
    ).rejects.toMatchObject({ status: 503 });
    expect(post).toHaveBeenCalledTimes(3);
  });
});

describe('receipt mismatches (kept as evidence)', () => {
  it.each([
    [
      'a swapped commitment',
      (r: Awaited<ReturnType<Harness['post']>>) => ({
        ...r,
        receipt: { ...r.receipt, commitment: `0x${'11'.repeat(32)}` as const },
      }),
      ['receipt.commitment'],
    ],
    [
      'a wrong beacon round',
      (r: Awaited<ReturnType<Harness['post']>>) => ({
        ...r,
        receipt: { ...r.receipt, beaconRound: r.receipt.beaconRound + 1 },
      }),
      ['receipt.beaconRound'],
    ],
    [
      'another stake in the entry',
      (r: Awaited<ReturnType<Harness['post']>>) => ({ ...r, entry: { ...r.entry, stake: '10' } }),
      ['entry.stake'],
    ],
  ] as const)('stores the pick with %s flagged', async (_name, tamper, fields) => {
    const round = testRound();
    const h = harness(round);
    h.tamper = tamper;
    const { pick } = await submitFreeEntry({ round, ...ENTRY }, deps(h));
    expect(pick.mismatches).toEqual(fields);
    expect(pick.evidence).toBeDefined();
  });

  it('flags a receipt signed over another commitment (a swapped pick)', async () => {
    const round = testRound();
    const h = harness(round);
    const own = await sealPick({ round, optionIndex: 0, chain: TEST_CHAIN });
    const other = await sealPick({ round, optionIndex: 1, chain: TEST_CHAIN });
    const { toBase64Url } = await import('@flocked/tlock');
    // The server signed (and echoed) the other ciphertext's commitment.
    const response = await signedEntry(
      round,
      { stake: '25', ciphertext: toBase64Url(other.ciphertext) },
      h.signer,
    );
    const bad = await receiptMismatches({
      response,
      round,
      stake: 25n,
      ciphertext: own.ciphertext,
      userId: TEST_USER_ID,
      chain: TEST_CHAIN,
      onchainSigner: h.signer.address,
    });
    expect(bad).toEqual(['entry.commitment', 'receipt.commitment', 'receipt.signature']);
  });

  it('flags a receipt signed by a key other than the onchain signer', async () => {
    const round = testRound();
    const h = harness(round);
    const sealed = await sealPick({ round, optionIndex: 0, chain: TEST_CHAIN });
    const { toBase64Url } = await import('@flocked/tlock');
    const impostor = privateKeyToAccount(generatePrivateKey());
    const response = await signedEntry(
      round,
      { stake: '25', ciphertext: toBase64Url(sealed.ciphertext) },
      impostor,
    );
    const bad = await receiptMismatches({
      response,
      round,
      stake: 25n,
      ciphertext: sealed.ciphertext,
      userId: TEST_USER_ID,
      chain: TEST_CHAIN,
      onchainSigner: h.signer.address,
    });
    expect(bad).toEqual(['receipt.signer', 'receipt.signature']);
  });

  it("flags another user's receipt and a foreign domain", async () => {
    const round = testRound();
    const h = harness(round);
    const sealed = await sealPick({ round, optionIndex: 0, chain: TEST_CHAIN });
    const { toBase64Url } = await import('@flocked/tlock');
    const response = await signedEntry(
      round,
      { stake: '25', ciphertext: toBase64Url(sealed.ciphertext) },
      h.signer,
      { userId: '01JA0000000000000000000XYZ', chain: { ...TEST_CHAIN, chainId: 8453 } },
    );
    const bad = await receiptMismatches({
      response,
      round,
      stake: 25n,
      ciphertext: sealed.ciphertext,
      userId: TEST_USER_ID,
      chain: TEST_CHAIN,
      onchainSigner: h.signer.address,
    });
    expect(bad).toEqual(['receipt.userIdHash', 'receipt.chainId', 'receipt.signature']);
  });
});

describe('sealPick', () => {
  it('opens with the recorded quicknet signature for its round (TL-1, Node half)', async () => {
    // Round 32,870,075 and its signature (packages/tlock/fixtures/quicknet-beacons.json).
    const round = testRound({ beaconRound: 32_870_075 });
    const nonce = new Uint8Array(16).fill(7);
    const sealed = await sealPick({
      round,
      optionIndex: 1,
      chain: TEST_CHAIN,
      randomBytes: () => nonce,
    });
    const plaintext = await decryptWithSignature(
      QUICKNET,
      sealed.ciphertext,
      '85c653c4e0099d069e9f7f525d14239c5f2ffa496f02ad5daf4e4e240de575261d5248172ad543b351b236c838853d8e',
    );
    const decoded = decodePlaintext(plaintext);
    expect(decoded?.optionIndex).toBe(1);
    expect(decoded?.nonce).toEqual(nonce);
    expect(sealed.nonce).toBe(`0x${'07'.repeat(16)}`);
  });

  it('makes a fixed-length ciphertext whichever option is picked', async () => {
    const round = testRound();
    const a = await sealPick({ round, optionIndex: 0, chain: TEST_CHAIN });
    const b = await sealPick({ round, optionIndex: 1, chain: TEST_CHAIN });
    expect(a.ciphertext.length).toBe(b.ciphertext.length);
  });
});
