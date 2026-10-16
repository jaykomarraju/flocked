// Playwright fixtures for the e2e specs (W7-D; wave-7.md "Pinned interfaces": `stack`, `wallet`,
// `user`, `clock`). `stack` and `clock` live for the worker (one, playwright.config.ts); `user` and
// `wallet` make new players and wallets per call.
import { test as base } from '@playwright/test';
import { Clock, warpRecord } from './clock';
import { Stack } from './stack';
import { newUser, type User } from './user';
import { newWallet, type Wallet } from './wallet';

interface WorkerFixtures {
  stack: Stack;
  clock: Clock;
}

interface TestFixtures {
  /** A new signed-in player; `{ stakes: true }` also verifies personhood and accepts the Terms. */
  user: (opts?: { stakes?: boolean }) => Promise<User>;
  /** A new EOA with gas on anvil. */
  wallet: () => Promise<Wallet>;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  stack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      // The two-phase rule (playwright.config.ts): a non-warp phase makes rounds, and the escrow
      // refuses `createRound` once anvil is past opensAt, so it never runs on a warped stack.
      const warped = warpRecord();
      if (warped !== null && !isWarpPhase(workerInfo.project.name)) {
        throw new Error(
          `project ${workerInfo.project.name} can't run on this stack: ${warped.project} already ` +
            `warped anvil to ${new Date(warped.at * 1000).toISOString()}. Start a fresh stack ` +
            '(pnpm stack:down && pnpm stack:up); `pnpm e2e` and `pnpm e2e:ui` each need one.',
        );
      }
      await use(new Stack());
    },
    { scope: 'worker' },
  ],
  clock: [
    async ({ stack }, use, workerInfo) => {
      const clock = new Clock(stack, workerInfo.project.name);
      await use(clock);
      // A spec that pinned the game clock and failed before releasing it leaves wall time behind
      // (after a warp, release() keeps the clock at or past anvil's head instead).
      if (clock.pinned !== null) await clock.release();
    },
    { scope: 'worker' },
  ],
  user: async ({ stack }, use) => {
    await use((opts) => newUser(stack, opts));
  },
  wallet: async ({ stack }, use) => {
    await use(() => newWallet(stack));
  },
});

/** A warp phase's project name ends in `-warp` (playwright.config.ts). */
export function isWarpPhase(project: string): boolean {
  return project.endsWith('-warp');
}

export { expect } from '@playwright/test';
export { poll, type SeamRound, type Stack } from './stack';
export type { Clock } from './clock';
export type { User } from './user';
export type { Wallet } from './wallet';
