// PIPE-6 (W9-B part): the CLI over bundles the W5-A pipeline produced, read from a directory that
// mirrors the bucket. W9-D runs the same CLI against the stack's bundles and chain (e2e).
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { manifestOf } from './helpers.js';
import { makeBundle, type Fixture } from './pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'flocked-verify.mjs');

async function writeBundle(f: Fixture, objects = f.objects): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flocked-verify-'));
  for (const [key, bytes] of objects) {
    await mkdir(dirname(join(dir, key)), { recursive: true });
    await writeFile(join(dir, key), bytes);
  }
  return dir;
}

async function cli(f: Fixture, dir: string, ...extra: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    [
      '--round',
      f.roundId,
      '--mode',
      f.mode,
      '--rpc',
      'http://127.0.0.1:1',
      '--chain-id',
      '31337',
      '--bundles',
      dir,
      ...extra,
    ],
    { out: (s) => out.push(s), err: (s) => err.push(s), env: {} },
    { reader: f.reader },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('flocked-verify (PIPE-6 fixtures)', () => {
  it('exit 0 on a Free bundle from the pipeline, and on a Stakes one', async () => {
    const f = await makeBundle('free', {
      entries: [{ option: 0 }, { option: 1 }, { option: 1 }, { sealed: 'wrong_target' }],
    });
    const r = await cli(f, await writeBundle(f));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/: MATCH/);
    expect(r.out).toContain(`bundleHash ${f.bundleHash}`);
    expect(r.err).toContain('… reading the bundle');

    const s = await makeBundle('stakes', {
      entries: [{ option: 0 }, { option: 1 }, { option: 1 }],
      stakes: { minEntrants: 3 },
    });
    const j = await cli(s, await writeBundle(s), '--json', '--quiet');
    expect(j.code).toBe(0);
    expect(j.err).toBe('');
    const report = JSON.parse(j.out) as { verdict: string; proposal: { status: string } };
    expect([report.verdict, report.proposal.status]).toEqual(['match', 'SettleProposed']);
  });

  it('exit 1 on a mismatch, 2 when the bundle is missing or the arguments are wrong', async () => {
    const f = await makeBundle('free', { entries: [{ option: 0 }, { option: 1 }] });
    const objects = new Map(f.objects);
    const key = manifestOf(f).chunks[0]?.key ?? '';
    const bytes = new Uint8Array(objects.get(key) ?? []);
    const at = bytes.length - 3;
    bytes[at] = (bytes[at] ?? 0) ^ 1;
    const bad = await cli(f, await writeBundle(f, objects.set(key, bytes)));
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/MISMATCH[\s\S]*FAIL chunk\.hash/);

    const missing = await cli(f, await mkdtemp(join(tmpdir(), 'flocked-verify-empty-')));
    expect(missing.code).toBe(2);
    expect(missing.out).toMatch(/UNVERIFIABLE[\s\S]*ERR {2}manifest\.fetch/);

    const usage = await cli(f, '/nowhere', '--mode', 'both');
    expect(usage.code).toBe(2);
    expect(usage.err).toContain('--mode must be free or stakes');
  });

  it('--account prints the entry and its payout proof; --drand-info reads a drand /info document', async () => {
    const f = await makeBundle('free', {
      entries: [{ option: 0 }, { option: 0 }, { option: 1 }, { option: 1 }, { option: 1 }],
    });
    const info = (
      JSON.parse(
        await readFile(join(here, '../../tlock/fixtures/quicknet-beacons.json'), 'utf8'),
      ) as { info: unknown }
    ).info;
    const dir = await writeBundle(f);
    await writeFile(join(dir, 'info.json'), JSON.stringify(info));
    const r = await cli(
      f,
      dir,
      '--account',
      f.accounts[0] ?? '',
      '--drand-info',
      join(dir, 'info.json'),
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/seq 0: stake 10, option 0\n {2}payout win \d+, proof \[0x[0-9a-f]{64}/);
  });

  it('the bin runs through node and a real viem client: an unreachable RPC is exit 2', async () => {
    const f = await makeBundle('free', { entries: [{ option: 0 }] });
    const dir = await writeBundle(f);
    const args = [
      BIN,
      '--round',
      f.roundId,
      '--mode',
      'free',
      '--rpc',
      'http://127.0.0.1:1',
      '--chain-id',
      '31337',
    ];
    const addr = [
      '--escrow',
      `0x${'11'.repeat(20)}`,
      '--anchor',
      `0x${'22'.repeat(20)}`,
      '--deploy-block',
      '0',
    ];
    const env = { PATH: process.env.PATH ?? '' };
    const run = (...a: string[]) =>
      promisify(execFile)(process.execPath, [...args, ...a], { env }).then(
        (r) => ({ code: 0, ...r }),
        (e: { code: number; stdout: string; stderr: string }) => e,
      );
    const r = await run('--bundles', dir, ...addr, '--quiet');
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(
      /UNVERIFIABLE[\s\S]*ok {3}record[\s\S]*ERR {2}verify: verification stopped/,
    );

    const help = await run('--help');
    expect(help.code).toBe(2);
    expect(help.stderr).toContain('Exit codes: 0 match, 1 mismatch, 2 unable to verify.');
  });
});
