import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { ulidToBytes } from '@flocked/shared';
import { verifyEntry } from '../src/verify.js';
import { ids, manifestOf, options, verify } from './helpers.js';
import { makeBundle } from './pipeline.js';

/** OpenZeppelin StandardMerkleTree: leaf = keccak(keccak(abi.encode(values))), sorted pairs. */
function processProof(leaf: Hex, proof: Hex[]): Hex {
  return proof.reduce<Hex>(
    (h, p) => (h < p ? keccak256(`${h}${p.slice(2)}`) : keccak256(`${p}${h.slice(2)}`)),
    leaf,
  );
}

describe('verifyRound: Free', () => {
  it('reproduces a daily round with every VOID reason, across several chunks', async () => {
    const f = await makeBundle('free', {
      entries: [
        { option: 0, stake: 40n },
        { option: 1, stake: 10n },
        { option: 1, stake: 100n },
        { sealed: 'garbage' },
        { sealed: 'wrong_target' },
        { sealed: 'bad_option' },
        { sealed: 'bad_plaintext' },
        { option: 0, stake: 101n }, // stake_out_of_range
        { option: 1 },
        { option: 0, stake: 101n }, // not_anchored (anchored: 9), which wins over stake_out_of_range
      ],
      anchored: 9,
      decryptChunk: 4,
      bundleChunk: 3,
    });
    const m = manifestOf(f);
    expect(m.chunks).toHaveLength(4);
    expect(m.voids).toEqual({
      non_canonical_header: 1,
      wrong_target: 1,
      bad_option: 1,
      bad_plaintext: 1,
      stake_out_of_range: 1,
      not_anchored: 1,
    });
    const r = await verify(f);
    expect(ids(r)).toEqual([]);
    expect(ids(r, 'error')).toEqual([]);
    expect(r.verdict).toBe('match');
    expect(r.exitCode).toBe(0);
    expect(ids(r, 'pass')).toEqual(
      expect.arrayContaining([
        'manifest.format',
        'chunk.hash',
        'chunk.totals',
        'drand.signature',
        'commitment.root',
        'entry.commitment',
        'entry.voidReason',
        'entry.pick',
        'record',
        'payoutRoot',
        'anchor.configHash',
        'anchor.commitment',
        'anchor.totalStake',
        'anchor.manifestHash',
        'anchor.anchorTx',
        'anchor.sender',
      ]),
    );
    expect(r.record?.voidCount).toBe(6n);
    expect(r.bundleHash).toBe(f.bundleHash);
  });

  it('reproduces a refunded Free mode (rule 1) and its refund tree', async () => {
    const f = await makeBundle('free', {
      entries: [{ option: 0 }, { option: 1 }],
      free: { minEntrants: 3 },
    });
    expect(f.outcome).toBe('refunded');
    const r = await verify(f);
    expect(r.verdict).toBe('match');
    expect(manifestOf(f).payoutRoot).not.toBeNull();
  });

  it('reproduces a Free mode with no entries', async () => {
    const f = await makeBundle('free', { entries: [] });
    const r = await verify(f);
    expect(ids(r)).toEqual([]);
    expect(r.verdict).toBe('match');
  });

  it('verifyEntry gives a payout and a proof that opens to the payout root', async () => {
    const f = await makeBundle('free', { entries: [{ option: 0 }, { option: 1 }, { option: 1 }] });
    const account = f.accounts[0] ?? '';
    const e = await verifyEntry({ ...options(f), account });
    expect(e.report.verdict).toBe('match');
    expect(e.entries.map((x) => x.seq)).toEqual([0]);
    const [p] = e.payouts;
    if (!p) throw new Error('no payout');
    const leaf = keccak256(
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes16' }, { type: 'bytes32' }, { type: 'uint256' }],
          [`0x${Buffer.from(ulidToBytes(f.roundId)).toString('hex')}`, account as Hex, p.amount],
        ),
      ),
    );
    expect(processProof(leaf, p.proof)).toBe(manifestOf(f).payoutRoot);
  });
});

describe('verifyRound: Stakes', () => {
  it('reproduces a settled Stakes mode against its proposal, ciphertexts from Entered logs', async () => {
    const options_ = [0, 1, 1, 0, 1] as const;
    const f = await makeBundle('stakes', {
      entries: [...options_.map((option) => ({ option })), { sealed: 'garbage' }],
      stakes: { minEntrants: 3 },
    });
    expect(f.outcome).toBe('settled');
    const r = await verify(f);
    expect(ids(r)).toEqual([]);
    expect(r.verdict).toBe('match');
    expect(ids(r, 'pass')).toEqual(
      expect.arrayContaining([
        'escrow.config',
        'escrow.closeBlock',
        'escrow.entries',
        'entry.account',
        'entry.voidReason',
        'record',
        'payoutRoot',
        'proposal.bundleHash',
        'proposal.outcome',
        'proposal.payoutRoot',
      ]),
    );
    expect(r.proposal?.status).toBe('SettleProposed');
  });

  it('reproduces a refunded Stakes mode (no payout tree)', async () => {
    const f = await makeBundle('stakes', { entries: [{ option: 0 }, { option: 1 }] });
    expect(f.outcome).toBe('refunded');
    const r = await verify(f);
    expect(r.verdict).toBe('match');
    expect(manifestOf(f).payoutRoot).toBeNull();
  });

  it('a ciphertext that differs from its Entered log is a mismatch', async () => {
    const f = await makeBundle('stakes', {
      entries: [{ option: 0 }, { option: 1 }, { option: 1 }],
      stakes: { minEntrants: 3 },
    });
    const [a, b] = f.reader.enteredLogs;
    if (!a || !b) throw new Error('logs');
    f.reader.enteredLogs = [{ ...a, ciphertext: b.ciphertext }, ...f.reader.enteredLogs.slice(1)];
    const r = await verify(f);
    expect(r.verdict).toBe('mismatch');
    expect(ids(r)).toContain('entry.pick');
  });

  it('an Entered log by another player is a mismatch', async () => {
    const f = await makeBundle('stakes', {
      entries: [{ option: 0 }, { option: 1 }, { option: 1 }],
      stakes: { minEntrants: 3 },
    });
    const [a, ...rest] = f.reader.enteredLogs;
    if (!a) throw new Error('logs');
    f.reader.enteredLogs = [{ ...a, player: `0x${'99'.repeat(20)}` }, ...rest];
    const r = await verify(f);
    expect(r.verdict).toBe('mismatch');
    expect(ids(r)).toEqual(['entry.account']);
  });

  it('an Entered log the bundle omits is a mismatch', async () => {
    const f = await makeBundle('stakes', {
      entries: [{ option: 0 }, { option: 1 }, { option: 1 }],
      stakes: { minEntrants: 3 },
    });
    if (f.reader.round) f.reader.round = { ...f.reader.round, entryCount: 4 };
    const r = await verify(f);
    expect(ids(r)).toContain('escrow.entries');
  });
});

describe('unable to verify', () => {
  it('no manifest published', async () => {
    const f = await makeBundle('free', { entries: [{ option: 0 }] });
    const r = await verify(f, new Map());
    expect(r.verdict).toBe('unverifiable');
    expect(r.exitCode).toBe(2);
    expect(ids(r, 'error')).toEqual(['manifest.fetch']);
  });

  it('a manifest not anchored yet', async () => {
    const f = await makeBundle('free', { entries: [{ option: 0 }] });
    if (f.reader.anchorState)
      f.reader.anchorState = { ...f.reader.anchorState, manifestAnchoredAt: 0n };
    const r = await verify(f);
    expect([r.verdict, ids(r, 'error')]).toEqual(['unverifiable', ['anchor.manifestHash']]);
  });

  it('no Stakes proposal yet', async () => {
    const f = await makeBundle('stakes', { entries: [{ option: 0 }] });
    f.reader.proposalLogs = [];
    const r = await verify(f);
    expect([r.verdict, ids(r, 'error')]).toEqual(['unverifiable', ['proposal.bundleHash']]);
  });

  it('an RPC failure', async () => {
    const f = await makeBundle('free', { entries: [{ option: 0 }] });
    f.reader.anchorState = null;
    const r = await verify(f);
    expect([r.verdict, ids(r, 'error')]).toEqual(['unverifiable', ['verify']]);
  });

  it('an anchor write whose log cannot be found (its sender is unknown)', async () => {
    const f = await makeBundle('free', { entries: [{ option: 0 }] });
    f.reader.logs = f.reader.logs.filter((l) => l.event !== 'ManifestAnchored');
    const r = await verify(f);
    expect([r.verdict, ids(r, 'error')]).toEqual(['unverifiable', ['anchor.sender']]);
  });

  it('a newer bundleFormat', async () => {
    const f = await makeBundle('free', { entries: [{ option: 0 }] });
    const objects = new Map(f.objects);
    const key = `bundles/${f.roundId}/free/manifest.json`;
    objects.set(
      key,
      new TextEncoder().encode(JSON.stringify({ ...manifestOf(f), bundleFormat: 2 })),
    );
    const r = await verify(f, objects);
    expect([r.verdict, ids(r, 'error')]).toEqual(['unverifiable', ['manifest.format']]);
  });
});

describe('disputed anchors (spec "Smart contract" › Stolen anchor key)', () => {
  it('reports each anchor sender and marks writes from a later-revoked key as disputed', async () => {
    const f = await makeBundle('free', { entries: [{ option: 0 }, { option: 1 }] });
    const sender = f.reader.logs[0]?.sender;
    if (!sender) throw new Error('no sender');
    expect((await verify(f)).anchors.every((a) => a.sender === sender && !a.disputed)).toBe(true);

    f.reader.revoked.set(sender, 250n); // after Locked (10) and Committed (20), before ManifestAnchored (300)
    const r = await verify(f);
    expect(r.disputed).toBe(true);
    expect(r.verdict).toBe('unverifiable');
    expect(r.exitCode).toBe(2);
    expect(r.anchors.map((a) => [a.event, a.disputed])).toEqual([
      ['Locked', true],
      ['Committed', true],
      ['ManifestAnchored', false],
    ]);
    expect(ids(r)).toEqual([]);
  });
});
