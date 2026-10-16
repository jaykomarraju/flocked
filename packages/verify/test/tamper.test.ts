// Required tamper tests (wave-9 "W9-B"): one byte in a chunk, the root, a VOID reason and a tally are
// each detected. The last three re-publish the bundle consistently (chunk hashes, manifest hash and
// the anchor or proposal all updated), so only recomputation can catch them.
import { describe, expect, it } from 'vitest';
import { ids, manifestOf, republish, verify } from './helpers.js';
import { makeBundle, type Fixture } from './pipeline.js';

const free = () =>
  makeBundle('free', {
    entries: [
      { option: 0, stake: 50n },
      { option: 1 },
      { option: 1 },
      { sealed: 'garbage' },
      { option: 0 },
    ],
    bundleChunk: 2,
  });
const stakes = () =>
  makeBundle('stakes', {
    entries: [{ option: 0 }, { option: 1 }, { option: 1 }, { sealed: 'bad_option' }],
    stakes: { minEntrants: 3 },
  });

async function expectMismatch(f: Fixture, objects: Map<string, Uint8Array>, ...failing: string[]) {
  const r = await verify(f, objects);
  expect(r.verdict).toBe('mismatch');
  expect(r.exitCode).toBe(1);
  expect(ids(r)).toEqual(expect.arrayContaining(failing));
}

describe.each([
  ['free', free],
  ['stakes', stakes],
] as const)('tamper: %s', (_mode, make) => {
  it('one byte in a chunk', async () => {
    const f = await make();
    const key = manifestOf(f).chunks[0]?.key ?? '';
    const bytes = new Uint8Array(f.objects.get(key) ?? []);
    const at = new TextDecoder().decode(bytes).indexOf('"stake":"') + 9; // a digit of the first stake
    bytes[at] = (bytes[at] ?? 0) === 0x31 ? 0x32 : 0x31;
    await expectMismatch(f, new Map(f.objects).set(key, bytes), 'chunk.hash');
  });

  it('the payout root', async () => {
    const f = await make();
    const objects = republish(f, {
      manifest: (m) => {
        m.payoutRoot = `0x${'ab'.repeat(32)}`;
      },
    });
    await expectMismatch(f, objects, 'payoutRoot');
  });

  it('a VOID reason', async () => {
    const f = await make();
    const objects = republish(f, {
      chunk: (c) => {
        const e = c.entries.find((x) => x.voidReason !== null);
        if (e) e.voidReason = 'decrypt_failed';
      },
      manifest: (m) => {
        m.voids = { decrypt_failed: 1 };
      },
    });
    await expectMismatch(f, objects, 'entry.voidReason');
  });

  it('a VOID turned into a valid pick', async () => {
    const f = await make();
    const objects = republish(f, {
      chunk: (c) => {
        const e = c.entries.find((x) => x.voidReason !== null);
        if (e)
          Object.assign(e, {
            option: 1,
            valid: true,
            voidReason: null,
            nonce: `0x${'00'.repeat(16)}`,
          });
      },
    });
    await expectMismatch(f, objects, 'entry.voidReason', 'entry.pick');
  });

  it('a tally: the chunk totals', async () => {
    const f = await make();
    const objects = republish(f, {
      manifest: (m) => {
        const t = m.chunks[0]?.totals[1];
        if (t) t.n = String(Number(t.n) + 1);
      },
    });
    await expectMismatch(f, objects, 'chunk.totals');
  });

  it("a tally: a chunk's VOID count", async () => {
    const f = await make();
    const objects = republish(f, {
      manifest: (m) => {
        const c = m.chunks.find((x) => x.voids > 0);
        if (c) c.voids -= 1;
      },
    });
    await expectMismatch(f, objects, 'chunk.totals');
  });

  it('a tally: the settlement record', async () => {
    const f = await make();
    const objects = republish(f, {
      manifest: (m) => {
        m.record.n = [m.record.n[0], String(Number(m.record.n[1]) + 1)];
      },
    });
    await expectMismatch(f, objects, 'record');
  });

  it('a manifest the chain never saw', async () => {
    const f = await make();
    const anchor = f.reader.anchorState;
    const proposals = f.reader.proposalLogs;
    const objects = republish(f, { manifest: (m) => void (m.closesAt += 1) });
    f.reader.anchorState = anchor;
    f.reader.proposalLogs = proposals;
    const r = await verify(f, objects);
    expect(r.verdict).toBe('mismatch');
    expect(ids(r)).toContainEqual(
      f.mode === 'free' ? 'anchor.manifestHash' : 'proposal.bundleHash',
    );
  });
});

describe('tamper: Free-only fields', () => {
  it('a ciphertext swapped for another valid one', async () => {
    const f = await free();
    const objects = republish(f, {
      chunk: (c) => {
        const [a, b] = c.entries;
        if (a && b && c.index === 0) a.ciphertext = b.ciphertext;
      },
    });
    await expectMismatch(f, objects, 'entry.commitment');
  });

  it('an entry dropped from the anchored set', async () => {
    const f = await free();
    const objects = republish(f, {
      chunk: (c) => {
        const e = c.entries.find((x) => x.seq === 1);
        if (e) e.stake = '11';
      },
      manifest: (m) => {
        const t = m.chunks[0]?.totals[1];
        if (t) t.w = String(BigInt(t.w) + 1n);
      },
    });
    await expectMismatch(f, objects, 'commitment.root');
  });

  it('a non-canonical encoding of the same manifest', async () => {
    const f = await free();
    const key = `bundles/${f.roundId}/free/manifest.json`;
    const pretty = new TextEncoder().encode(JSON.stringify(manifestOf(f), null, 1));
    const r = await verify(f, new Map(f.objects).set(key, pretty));
    expect(ids(r)).toContain('manifest.format');
  });
});
