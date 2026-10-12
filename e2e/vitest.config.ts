// e2e tests run in Node against the local stack (`pnpm stack:up`); they are not part of `pnpm test`.
import { basename } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * The stack tests in CI's order (.github/workflows/stack.yml). stakes-settle moves anvil's clock 2 h
 * forward for good, so only tests that build on its round (claims-wallet) run after it; a file not
 * listed here runs just before stakes-settle.
 */
const STACK_ORDER = [
  'stack-smoke',
  'lifecycle-open-close',
  'free-settle',
  'anchor-tx',
  'indexer-reorg',
  'stakes-ticket',
  'stakes-settle',
  'claims-wallet',
];

const rank = (file: string): number => {
  const i = STACK_ORDER.indexOf(basename(file).replace(/\.test\.ts$/, ''));
  return i === -1 ? STACK_ORDER.indexOf('stakes-settle') - 0.5 : i;
};

/** Runs the files in STACK_ORDER, so a plain `vitest run` is safe on one stack. */
class StackSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve(
      [...files].sort(
        (a, b) => rank(a.moduleId) - rank(b.moduleId) || a.moduleId.localeCompare(b.moduleId),
      ),
    );
  }
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // A round has to close and its beacon arrive (beaconDelay 60 s on a 3 s chain).
    testTimeout: 240_000,
    hookTimeout: 60_000,
    // Every file shares the stack's anvil and its keys, and some turn automine off or revert
    // snapshots (anchor-tx, indexer-reorg), so files run one at a time, in STACK_ORDER.
    fileParallelism: false,
    sequence: { sequencer: StackSequencer },
  },
});
