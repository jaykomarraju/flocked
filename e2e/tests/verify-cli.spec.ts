// PIPE-6, end to end (W9-D): `flocked-verify` (packages/verify, W9-B) reproduces a round the stack
// settled from public data only: the API's public bundle route, anvil and the local drand network's
// /info. Three players enter both modes of a daily-shaped round that only the cron driver and the DOs'
// alarms move. Once Free has settled and its manifest is anchored, `--mode free` exits 0; once the
// Stakes proposal is confirmed, `--mode stakes` exits 0 (W9-B: exit 2 means "not yet verifiable", so
// the spec retries while the CLI answers 2). A copy of the Free bundle with one hex digit of a chunk's
// commitment changed exits 1.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DEPLOYMENT_FILE, ROOT } from '../stack/env.mjs';
import { expect, poll, test, type Stack, type User } from '../fixtures';
import {
  enterFree,
  enterStakes,
  publicRound,
  scheduleRound,
  waitRound,
  type Pick,
} from '../fixtures/rounds';

/** Option 0 is the minority in both modes. */
const PICKS: Pick[] = [0, 1, 1];
const STAKE = 1_000_000n;
const CLI = join(ROOT, 'packages', 'verify', 'bin', 'flocked-verify.mjs');

interface CliRun {
  code: number;
  report: { verdict: string; checks: { name: string; status: string; detail?: string }[] } | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI as a user would, from the repo root, with `--json`. */
function verify(
  stack: Stack,
  roundId: string,
  mode: 'free' | 'stakes',
  bundles: string,
): Promise<CliRun> {
  const args = [
    CLI,
    '--round',
    roundId,
    '--mode',
    mode,
    '--rpc',
    stack.rpcUrl,
    '--chain-id',
    String(stack.chainId),
    '--deployment',
    DEPLOYMENT_FILE,
    '--bundles',
    bundles,
    '--drand-info',
    `${stack.drandUrl}/info`,
    '--json',
    '--quiet',
  ];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: ROOT, timeout: 180_000, maxBuffer: 16 << 20 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        let report: CliRun['report'] = null;
        try {
          report = JSON.parse(stdout) as CliRun['report'];
        } catch {
          // Not JSON (a usage error or a crash): the code and stderr say why.
        }
        resolve({ code, report, stdout, stderr });
      },
    );
  });
}

/** What failed, for an assertion message. */
const failing = (r: CliRun) =>
  r.report
    ? JSON.stringify(r.report.checks.filter((c) => c.status !== 'pass'))
    : `${r.stderr.slice(-2000)}`;

/** Retries while the CLI answers 2 (not anchored or proposed yet), then returns its answer. */
function verifyOnce(stack: Stack, roundId: string, mode: 'free' | 'stakes', bundles: string) {
  return poll(`flocked-verify --mode ${mode} to answer 0 or 1`, 240_000, async () => {
    await stack.testClient.mine({ blocks: 4 });
    const run = await verify(stack, roundId, mode, bundles);
    return run.code === 2 ? null : run;
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('PIPE-6: flocked-verify against the stack bundles', () => {
  const players: User[] = [];
  let roundId: string;

  test('setup: three players enter both modes of a round', async ({ stack, clock, user }) => {
    await clock.release();
    for (let i = 0; i < PICKS.length; i++) players.push(await user({ stakes: true }));
    ({ roundId } = await scheduleRound(stack, {
      opensInMs: 20_000,
      openForMs: 60_000,
      beaconDelay: 60,
      stakes: { stake: String(STAKE), minEntrants: 3, capMultiple: 1 },
    }));
    const open = await waitRound(
      stack,
      roundId,
      'the round to open',
      90_000,
      (r) => r.status === 'open',
    );
    for (const [i, p] of players.entries()) {
      await enterFree(stack, p, open, PICKS[i]!, 25n);
      await enterStakes(stack, clock, p, open, PICKS[i]!);
    }
  });

  test('Free: settled and anchored, the CLI reproduces it (exit 0)', async ({ stack, clock }) => {
    await poll('Free to settle', 300_000, async () => {
      await clock.mine(4);
      const r = await publicRound(stack, roundId);
      return r?.modes.free?.status === 'settled' ? r : null;
    });
    const run = await verifyOnce(stack, roundId, 'free', `${stack.apiUrl}/api/v1`);
    expect(run.code, failing(run)).toBe(0);
    expect(run.report?.verdict).toBe('match');
  });

  test('Stakes: proposed, the CLI reproduces it against the proposal (exit 0)', async ({
    stack,
    clock,
  }) => {
    await poll('the Stakes proposal', 300_000, async () => {
      await clock.mine(4);
      const r = await publicRound(stack, roundId);
      return r?.modes.stakes?.status === 'settle_proposed' ? r : null;
    });
    const run = await verifyOnce(stack, roundId, 'stakes', `${stack.apiUrl}/api/v1`);
    expect(run.code, failing(run)).toBe(0);
    expect(run.report?.verdict).toBe('match');
  });

  test('a tampered chunk: the copy matches until one hex digit changes, then exit 1', async ({
    stack,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'flocked-verify-'));
    try {
      // A bucket mirror of the Free bundle, from the public route.
      const base = `${stack.apiUrl}/api/v1/rounds/${roundId}/bundles/free`;
      const get = async (file: string) => {
        const res = await fetch(`${base}/${file}`);
        expect(res.status, file).toBe(200);
        return Buffer.from(await res.arrayBuffer());
      };
      const save = (key: string, bytes: Buffer) => {
        mkdirSync(dirname(join(dir, key)), { recursive: true });
        writeFileSync(join(dir, key), bytes);
      };
      const manifest = await get('manifest.json');
      save(`bundles/${roundId}/free/manifest.json`, manifest);
      const keys = (
        JSON.parse(manifest.toString('utf8')) as { chunks: { key: string }[] }
      ).chunks.map((c) => c.key);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) save(key, await get(basename(key)));
      const copy = await verify(stack, roundId, 'free', dir);
      expect(copy.code, failing(copy)).toBe(0);

      // One hex digit of the first entry's commitment: still valid JSON, a different chunk hash.
      const first = join(dir, keys[0]!);
      const text = readFileSync(first, 'utf8');
      const at = text.indexOf('"commitment":"0x') + '"commitment":"0x'.length;
      expect(at).toBeGreaterThan('"commitment":"0x'.length);
      writeFileSync(
        first,
        `${text.slice(0, at)}${text[at] === 'a' ? 'b' : 'a'}${text.slice(at + 1)}`,
      );
      const run = await verify(stack, roundId, 'free', dir);
      expect(run.code, failing(run)).toBe(1);
      expect(run.report?.verdict).toBe('mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
