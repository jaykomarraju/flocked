// PIPE-4: the manifest is a deterministic function of chain data, the drand round and the
// settlement inputs, with no relay identity, so two runs give byte-identical bundles.
import { env } from 'cloudflare:test';
import { canonicalJson } from '@flocked/shared';
import { describe, expect, it } from 'vitest';
import { manifestKey } from '../../src/settlement/keys.js';
import {
  RELAYS,
  atBeaconPlus,
  bundleObjects,
  fakeRelays,
  harness,
  pick,
  seedFreeRound,
  voidCiphertexts,
} from './helpers.js';

async function clearRound(roundId: string): Promise<void> {
  for (const prefix of [`bundles/${roundId}/`, `settlement/${roundId}/`]) {
    const listed = await env.BUCKET.list({ prefix });
    await env.BUCKET.delete(listed.objects.map((o) => o.key));
  }
}

describe('PIPE-4 deterministic manifests', () => {
  it('PIPE-4: two runs give byte-identical bundles, including after a retry from another relay', async () => {
    atBeaconPlus(5_000);
    const r = await seedFreeRound(
      async (roundId) => {
        const v = await voidCiphertexts(roundId);
        const options = [0, 1, 1, 0, 1, 1, 1] as const;
        return [
          ...(await Promise.all(options.map(async (o) => ({ ct: await pick(roundId, o) })))),
          { ct: v.wrong_target },
          { ct: v.non_canonical_header },
          { ct: await pick(roundId, 1), stake: 25 },
        ];
      },
      { mirror: true },
    );
    const sizes = { decrypt: 3, bundle: 4 };

    // Run 1: relay A answers at once; chunks finish in order.
    const first = await harness(r.roundId, { sizes });
    expect((await first.run()).phase).toBe('done');
    const bundle1 = await bundleObjects(r.roundId);
    const hash1 = first.applied[0]?.bundleHash;
    expect(bundle1.size).toBe(4); // 3 chunks + the manifest
    expect(new TextDecoder().decode(bundle1.get(manifestKey(r.roundId, 'free')))).not.toMatch(
      /relay-/,
    );

    // Run 2, from nothing (no bundle, no working files, no DO state): the beacon is missing on A and
    // B serves a bad signature; the retry starts at B, which now answers. Chunks finish in reverse.
    await clearRound(r.roundId);
    const relays = fakeRelays((relay, call) => {
      if (call <= 2) return relay === RELAYS[0] ? 'missing' : 'bad_signature';
      return 'ok';
    });
    const second = await harness(r.roundId, { sizes, relays, fresh: true });
    await second.start();
    expect((await second.alarm()).phase).toBe('preparing');
    expect((await second.alarm()).phase).toBe('decrypting');
    expect(relays.calls.map((u) => new URL(u).origin)).toEqual([...RELAYS, RELAYS[1]]);
    await second.deliver([...second.sent].reverse());
    expect((await second.alarm()).phase).toBe('done');

    const bundle2 = await bundleObjects(r.roundId);
    expect([...bundle2.keys()]).toEqual([...bundle1.keys()]);
    for (const [key, bytes] of bundle1) expect(bundle2.get(key), key).toEqual(bytes);
    expect(second.applied[0]?.bundleHash).toBe(hash1);
    expect(second.applied[0]?.manifestBytes).toEqual(first.applied[0]?.manifestBytes);
  });

  it('PIPE-4: every bundle object is RFC 8785 canonical JSON', async () => {
    atBeaconPlus(5_000);
    const r = await seedFreeRound(async (roundId) => [
      { ct: await pick(roundId, 0) },
      { ct: await pick(roundId, 1) },
      { ct: await pick(roundId, 1) },
    ]);
    const h = await harness(r.roundId, { sizes: { decrypt: 2, bundle: 2 } });
    expect((await h.run()).phase).toBe('done');
    const objects = await bundleObjects(r.roundId);
    expect(objects.size).toBe(3);
    for (const [key, bytes] of objects) {
      const text = new TextDecoder().decode(bytes);
      expect(canonicalJson(JSON.parse(text)), key).toBe(text);
    }
  });
});
