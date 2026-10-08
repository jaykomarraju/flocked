import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as prettier from 'prettier';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONTRACTS,
  ROOT,
  generate,
  inputFiles,
  inputsHash,
  recordedHash,
} from '../scripts/gen.mjs';
import { flockedAnchorAbi, flockedEscrowAbi, mockUsdcAbi } from '../src/index';

const PKG = join(ROOT, 'packages/abi');
const GENERATED = [...CONTRACTS.map((c) => `src/${c.file}`), 'src/deployments.ts'];

function functionNames(abi: readonly { type: string; name?: string }[]): string[] {
  return abi.filter((e) => e.type === 'function').map((e) => e.name ?? '');
}

describe('generated files', () => {
  it('are current: each records the hash of the contract sources it was generated from', () => {
    const hash = inputsHash();
    for (const file of GENERATED) {
      const source = readFileSync(join(PKG, file), 'utf8');
      expect(recordedHash(source), `${file} is stale: run \`pnpm contracts:build\``).toBe(hash);
    }
  });

  it('hash every contract source, the mock USDC, the dependency lock and committed deployments', () => {
    const files = inputFiles();
    expect(files).toContain('contracts/src/FlockedEscrow.sol');
    expect(files).toContain('contracts/src/FlockedAnchor.sol');
    expect(files).toContain('contracts/src/interfaces/IFlockedAnchor.sol');
    expect(files).toContain('contracts/test/mocks/MockUSDC.sol');
    expect(files).toContain('contracts/soldeer.lock');
    expect(files.some((f) => f.includes('31337'))).toBe(false);
  });
});

describe('ABIs', () => {
  it('include the amended escrow: admin-only unpause and the single guardian', () => {
    const names = functionNames(flockedEscrowAbi);
    for (const fn of [
      'transferGuardian',
      'guardian',
      'unpause',
      'pause',
      'executeGuardianReplacement',
    ]) {
      expect(names).toContain(fn);
    }
    expect(names).not.toContain('withdrawTo');
    const events = flockedEscrowAbi.filter((e) => e.type === 'event').map((e) => e.name);
    expect(events).toContain('GuardianTransferred');
    const errors = flockedEscrowAbi.filter((e) => e.type === 'error').map((e) => e.name);
    expect(errors).toContain('SingleGuardian');
  });

  it('include the anchor interface (spec plus P2.2)', () => {
    const names = functionNames(flockedAnchorAbi);
    for (const fn of [
      'lock',
      'commit',
      'anchorManifest',
      'receiptSigner',
      'getAnchor',
      'roundKey',
      'beaconTime',
      'receiptDigest',
      'verifyReceipt',
      'scheduleReceiptSigner',
      'scheduleAnchorGrant',
    ]) {
      expect(names).toContain(fn);
    }
    const events = flockedAnchorAbi.filter((e) => e.type === 'event').map((e) => e.name);
    for (const ev of ['Locked', 'Committed', 'ManifestAnchored', 'ReceiptSignerSet', 'Skipped']) {
      expect(events).toContain(ev);
    }
  });

  it('include MockUSDC with mint and permit', () => {
    const names = functionNames(mockUsdcAbi);
    expect(names).toEqual(expect.arrayContaining(['mint', 'permit', 'decimals', 'approve']));
  });
});

describe('generate()', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'flocked-abi-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('embeds committed deployments, ignores the local one, and stays in Prettier style', async () => {
    // Synthetic inputs, so the test needs no Foundry build: one source, the mock, the lock, an ABI per artifact.
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(tmp, file)), { recursive: true });
      writeFileSync(join(tmp, file), text);
    };
    write('contracts/src/A.sol', 'contract A {}\n');
    write('contracts/test/mocks/MockUSDC.sol', 'contract MockUSDC {}\n');
    write('contracts/soldeer.lock', '');
    const abi = [
      {
        type: 'function',
        name: 'lock',
        inputs: [{ name: 'roundKeys', type: 'bytes32[]', internalType: 'bytes32[]' }],
        outputs: [],
        stateMutability: 'nonpayable',
      },
      {
        type: 'event',
        name: 'Skipped',
        inputs: [{ name: 'roundKey', type: 'bytes32', indexed: true, internalType: 'bytes32' }],
        anonymous: false,
      },
    ];
    for (const c of CONTRACTS) write(`contracts/out/${c.artifact}`, JSON.stringify({ abi }));
    const base = {
      anchor: '0x106066550B5D2c96dBC22e68694E1bC35F468FEB',
      deployBlock: 36_000_123,
      escrow: '0xAfbec55AF270df7Ac28Ab0F193551d5062Bd1083',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    };
    write('contracts/deployments/8453.json', JSON.stringify(base));
    write('contracts/deployments/31337.json', JSON.stringify(base));

    const { hash, files } = generate(tmp);
    expect(hash).not.toBe(inputsHash());
    const deployments = files['src/deployments.ts'] ?? '';
    expect(deployments).toContain('8453: {');
    expect(deployments).toContain('deployBlock: 36000123n,');
    expect(deployments).not.toContain('31337:');

    const options = {
      ...(await prettier.resolveConfig(join(PKG, 'src/x.ts'))),
      parser: 'typescript',
    };
    expect(files['src/FlockedAnchor.ts']).toContain("name: 'lock',");
    for (const [file, source] of Object.entries(files)) {
      expect(await prettier.check(source, options), `${file} is not in Prettier style`).toBe(true);
    }
  });
});
