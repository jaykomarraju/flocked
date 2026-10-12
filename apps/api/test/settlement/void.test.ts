// SET-4 (pipeline half): every VOID kind, from real tlock ciphertexts and real D1 rows, is excluded
// from the tally and refunded in full. The math half is packages/settle/test/void.test.ts, the
// classification half packages/tlock/test/classify.test.ts.
import { VOID_REASONS } from '@flocked/settle';
import { describe, expect, it } from 'vitest';
import type { BundleChunk } from '../../src/settlement/types.js';
import {
  atBeaconPlus,
  bundleObjects,
  harness,
  mirrorCommitted,
  modeStatus,
  pick,
  seedFreeRound,
  voidCiphertexts,
} from './helpers.js';

describe('SET-4 VOID entries in the pipeline', () => {
  it('SET-4: each VOID kind from real ciphertexts is excluded from the tally and refunded', async () => {
    atBeaconPlus(5_000);
    const expected = [
      null,
      null,
      null,
      'non_canonical_header',
      'wrong_target',
      'decrypt_failed',
      'bad_plaintext',
      'bad_option',
      'stake_out_of_range',
      'not_anchored',
    ] as const;
    const r = await seedFreeRound(
      async (roundId) => {
        const v = await voidCiphertexts(roundId);
        return [
          { ct: await pick(roundId, 0) },
          { ct: await pick(roundId, 1) },
          { ct: await pick(roundId, 1) },
          { ct: v.non_canonical_header },
          { ct: v.wrong_target },
          { ct: v.decrypt_failed },
          { ct: v.bad_plaintext },
          { ct: v.bad_option },
          // A valid pick, but its stake is outside the locked range (10–100).
          { ct: await pick(roundId, 0), stake: 5 },
          // A valid pick that the anchored commitment does not cover.
          { ct: await pick(roundId, 0), stake: 40 },
        ];
      },
      { anchored: 9, mirror: true },
    );
    expect(new Set(expected.filter((x) => x !== null))).toEqual(new Set(VOID_REASONS));

    const h = await harness(r.roundId, { sizes: { decrypt: 4, bundle: 6 } });
    expect((await h.run()).phase).toBe('done');
    const result = h.applied[0];
    if (!result) throw new Error('applyFree was not called');

    expect(result.entries.map((e) => e.voidReason)).toEqual(expected);
    expect(result.entries.map((e) => e.option)).toEqual([0, 1, 1, ...Array<null>(7).fill(null)]);
    // Only the three valid entries are tallied: 1 vs 2, so option 0 wins.
    expect(result.record).toMatchObject({
      outcome: 'settled',
      winner: 0,
      n: [1n, 2n],
      w: [10n, 20n],
      voidCount: 7n,
      voidStake: 5n * 10n + 5n + 40n,
    });
    const refunds = result.payouts.filter((p) => p.kind === 'void_refund');
    expect(refunds.map((p) => [p.account, p.amount]).sort()).toEqual(
      r.entries
        .slice(3)
        .map((e) => [e.userIdHash, BigInt(e.stake)])
        .sort(),
    );
    expect(result.manifest.voids).toEqual(
      Object.fromEntries(expected.filter((x) => x !== null).map((x) => [x, 1])),
    );
    expect(result.manifest.commitment).toMatchObject({ root: r.root, entryCount: 9 });

    // The bundle records each VOID with its reason, and keeps every Free ciphertext.
    const chunks = [...(await bundleObjects(r.roundId))]
      .filter(([k]) => k.includes('/chunk-'))
      .map(([, b]) => JSON.parse(new TextDecoder().decode(b)) as BundleChunk);
    const entries = chunks.flatMap((c) => c.entries);
    expect(entries.map((e) => e.voidReason)).toEqual(expected);
    expect(entries.map((e) => e.valid)).toEqual(expected.map((x) => x === null));
    expect(entries.every((e) => typeof e.ciphertext === 'string' && e.ciphertext.length > 0)).toBe(
      true,
    );
    expect(
      entries.filter((e) => !e.valid).every((e) => e.option === null && e.nonce === null),
    ).toBe(true);
  });

  it('SET-4: without the mirrored count the job waits; once mirrored, later entries are not_anchored', async () => {
    atBeaconPlus(5_000);
    // D1 has a fourth entry the anchored commitment does not cover, and the indexer hasn't mirrored
    // the Committed event yet: the anchored set is unknown, so nothing is decided.
    const r = await seedFreeRound(
      async (roundId) => [
        { ct: await pick(roundId, 0) },
        { ct: await pick(roundId, 1) },
        { ct: await pick(roundId, 1) },
        { ct: await pick(roundId, 0) },
      ],
      { anchored: 3, mirror: false },
    );
    const h = await harness(r.roundId);
    await h.start();
    expect(await h.alarm()).toMatchObject({ phase: 'preparing', error: null });
    expect(await modeStatus(r.roundId)).toBe('pending');
    expect(h.sent).toEqual([]);

    await mirrorCommitted(r, 3);
    expect((await h.alarm()).phase).toBe('decrypting');
    await h.deliver();
    expect((await h.alarm()).phase).toBe('done');
    expect(h.applied[0]?.entries.map((e) => e.voidReason)).toEqual([
      null,
      null,
      null,
      'not_anchored',
    ]);
    expect(h.applied[0]?.manifest.commitment).toMatchObject({ root: r.root, entryCount: 3 });
  });
});
