// PIPE-5 (Stakes: match and mismatch) and AC-4 (the VOID recompute part) at the level the watcher
// publishes verdicts at: the full recompute through `@flocked/verify`, over a real Stakes bundle
// and tampered copies of it, with the chain state the proposal posted.
import { QUICKNET } from '@flocked/tlock';
import { memorySource, verifyRound, type VerifyRoundOptions } from '@flocked/verify';
import { describe, expect, it } from 'vitest';
import { fromReportVerdict } from '../src/decide.js';
import {
  manifestKeyOf,
  parseJson,
  republish,
  stakesFixture,
  type FixtureManifest,
  type StakesFixture,
} from './fixture.js';

const ADDRESSES = {
  escrow: '0x1111111111111111111111111111111111111111',
  anchor: '0x2222222222222222222222222222222222222222',
  deployBlock: 0n,
} as const;

function options(f: StakesFixture, objects = f.objects): VerifyRoundOptions {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    chainId: 31337,
    roundId: f.roundId,
    mode: 'stakes',
    bundleBaseUrl: 'memory:',
    drand: QUICKNET,
    addresses: ADDRESSES,
    source: memorySource(objects),
    reader: f.reader,
  };
}

const failures = (checks: { id: string; status: string }[]) =>
  checks.filter((c) => c.status === 'fail').map((c) => c.id);

describe('PIPE-5: the watcher recomputes a Stakes proposal', () => {
  it('a round the operator settled honestly is a match', async () => {
    const f = await stakesFixture();
    expect(f.record.outcome).toBe('settled');
    // Four on option 0, one on option 1: the smaller side wins.
    expect(f.record.winner).toBe(1);
    expect(f.record.voidCount).toBe(2n);

    const report = await verifyRound(options(f));
    expect(failures(report.checks)).toEqual([]);
    expect(report.verdict).toBe('match');
    expect(report.exitCode).toBe(0);
    expect(fromReportVerdict(report.verdict)).toBe('match');
    expect(report.proposal?.bundleHash).toBe(f.bundleHash);
  });

  it('a payout root the proposal did not derive is a mismatch', async () => {
    const f = await stakesFixture();
    const objects = republish(f, {
      manifest: (m) => {
        m.payoutRoot = `0x${'ab'.repeat(32)}`;
      },
    });
    const report = await verifyRound(options(f, objects));
    expect(report.verdict).toBe('mismatch');
    expect(fromReportVerdict(report.verdict)).toBe('mismatch');
    expect(failures(report.checks)).toContain('payoutRoot');
  });

  it('a tally the entries do not support is a mismatch', async () => {
    const f = await stakesFixture();
    const objects = republish(f, {
      manifest: (m) => {
        m.record = { ...m.record, n: ['3', '2'] };
      },
    });
    const report = await verifyRound(options(f, objects));
    expect(report.verdict).toBe('mismatch');
    expect(failures(report.checks)).toContain('record');
  });

  it('one byte changed inside a chunk is a mismatch', async () => {
    const f = await stakesFixture();
    const objects = new Map(f.objects);
    const key = `bundles/${f.roundId}/stakes/chunk-0000.json`;
    const bytes = objects.get(key);
    if (!bytes) throw new Error('no chunk');
    const copy = Uint8Array.from(bytes);
    copy[copy.length - 2] = copy[copy.length - 2] === 125 ? 126 : 125;
    objects.set(key, copy);
    const report = await verifyRound(options(f, objects));
    expect(report.verdict).toBe('mismatch');
  });

  it('a proposal that posts another manifest is a mismatch', async () => {
    const f = await stakesFixture();
    f.reader.proposalLogs = f.reader.proposalLogs.map((p) => ({
      ...p,
      bundleHash: `0x${'cd'.repeat(32)}`,
    }));
    const report = await verifyRound(options(f));
    expect(report.verdict).toBe('mismatch');
    expect(failures(report.checks)).toContain('proposal.bundleHash');
  });

  it('a round with no proposal yet is unable to verify, not a mismatch', async () => {
    const f = await stakesFixture();
    f.reader.proposalLogs = [];
    const report = await verifyRound(options(f));
    expect(report.verdict).toBe('unverifiable');
    expect(fromReportVerdict(report.verdict)).toBe('unable');
    expect(failures(report.checks)).toEqual([]);
  });

  it('a bundle that is not published is unable to verify', async () => {
    const f = await stakesFixture();
    const report = await verifyRound(options(f, new Map()));
    expect(fromReportVerdict(report.verdict)).toBe('unable');
  });
});

describe('AC-4: every VOID recomputes from public data', () => {
  it('the bundle names the reasons the ciphertexts really have', async () => {
    const f = await stakesFixture();
    const m = parseJson<FixtureManifest>(
      f.objects.get(manifestKeyOf(f.roundId)) ?? new Uint8Array(),
    );
    expect(m.voids).toEqual({ wrong_target: 1, bad_plaintext: 1 });
    const report = await verifyRound(options(f));
    expect(report.verdict).toBe('match');
  });

  it('a VOID relabelled with another reason is a mismatch', async () => {
    const f = await stakesFixture();
    const objects = republish(f, {
      chunk: (c) => {
        for (const e of c.entries) if (e.voidReason === 'wrong_target') e.voidReason = 'bad_option';
      },
      manifest: (m) => {
        m.voids = { bad_option: 1, bad_plaintext: 1 };
      },
    });
    const report = await verifyRound(options(f, objects));
    expect(report.verdict).toBe('mismatch');
    expect(failures(report.checks)).toContain('entry.voidReason');
  });

  it('a VOID passed off as a valid pick is a mismatch', async () => {
    const f = await stakesFixture();
    const objects = republish(f, {
      chunk: (c) => {
        for (const e of c.entries) {
          if (e.voidReason !== 'bad_plaintext') continue;
          e.option = 1;
          e.nonce = `0x${'07'.repeat(16)}`;
          e.valid = true;
          e.voidReason = null;
        }
      },
      manifest: (m) => {
        m.voids = { wrong_target: 1 };
        m.record = { ...m.record, n: ['4', '2'], voidCount: '1' };
        for (const ref of m.chunks) {
          if (ref.index !== 1) continue;
          ref.totals = [
            { n: '0', w: '0' },
            { n: '1', w: String(5_000_000) },
          ];
          ref.voids = 1;
        }
      },
    });
    const report = await verifyRound(options(f, objects));
    expect(report.verdict).toBe('mismatch');
    expect(failures(report.checks)).toContain('entry.pick');
  });

  it('a valid pick turned into a VOID is a mismatch', async () => {
    const f = await stakesFixture();
    const objects = republish(f, {
      chunk: (c) => {
        for (const e of c.entries) {
          if (e.seq !== 4) continue;
          e.option = null;
          e.nonce = null;
          e.valid = false;
          e.voidReason = 'decrypt_failed';
        }
      },
      manifest: (m) => {
        m.voids = { decrypt_failed: 1, wrong_target: 1, bad_plaintext: 1 };
        for (const ref of m.chunks) {
          if (ref.index !== 0) continue;
          ref.totals = [
            { n: '4', w: String(20_000_000) },
            { n: '0', w: '0' },
          ];
          ref.voids = 1;
        }
      },
    });
    const report = await verifyRound(options(f, objects));
    expect(report.verdict).toBe('mismatch');
    expect(failures(report.checks)).toContain('entry.voidReason');
  });
});
