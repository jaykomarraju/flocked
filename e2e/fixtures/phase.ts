// What a spec's `api` phase hands its `api-warp` phase (playwright.config.ts): the round and its
// players, as JSON under e2e/stack/.run/e2e/ (gitignored, and gone with the stack: `stack:up` and
// `stack:down` delete .run). Player keys are throwaway test keys generated for this stack run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { RUN_DIR } from '../stack/env.mjs';
import type { Stack } from './stack';
import type { User } from './user';
import { walletFromKey } from './wallet';

const PHASE_DIR = join(RUN_DIR, 'e2e');

interface SavedUser {
  userId: string;
  token: string;
  ip: string;
  key: Hex;
}

export function savePhase(spec: string, data: object): void {
  mkdirSync(PHASE_DIR, { recursive: true });
  writeFileSync(join(PHASE_DIR, `${spec}.json`), `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function loadPhase<T>(spec: string): T {
  const file = join(PHASE_DIR, `${spec}.json`);
  if (!existsSync(file)) {
    throw new Error(
      `${spec}: no saved phase; its \`api\` project tests must run first on this stack`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function saveUser(u: User): SavedUser {
  if (!u.wallet.key) throw new Error('only a generated wallet can be saved');
  return { userId: u.userId, token: u.token, ip: u.ip, key: u.wallet.key };
}

export function loadUser(stack: Stack, s: SavedUser): User {
  return { userId: s.userId, token: s.token, ip: s.ip, wallet: walletFromKey(stack, s.key) };
}

export type { SavedUser };
