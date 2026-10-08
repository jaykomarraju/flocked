import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WS_SERVER_MESSAGE_TYPES, WsServerMessageSchema } from '../src/ws';
import type { WsServerMessage } from '../src/ws';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/ws/${name}`, import.meta.url), 'utf8')) as T;

const valid = read<WsServerMessage[]>('valid.json');
const invalid = read<{ why: string; value: unknown }[]>('invalid.json');

describe('WebSocket server messages', () => {
  it('match the types in the spec table, in order', () => {
    const text = execFileSync(
      process.execPath,
      [
        'scripts/spec-section.mjs',
        'Real-time and the reveal',
        '--sub',
        'WebSocket messages (server → client)',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const types = [...text.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
    expect(types).toEqual([...WS_SERVER_MESSAGE_TYPES]);
  });

  it('every type has a valid fixture', () => {
    expect([...new Set(valid.map((m) => m.type))].sort()).toEqual(
      [...WS_SERVER_MESSAGE_TYPES].sort(),
    );
  });

  for (const message of valid) {
    it(`accepts and round-trips a ${message.type} message`, () => {
      const parsed = WsServerMessageSchema.parse(message);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(message);
    });
  }

  for (const c of invalid) {
    it(`rejects: ${c.why}`, () => {
      expect(WsServerMessageSchema.safeParse(c.value).success).toBe(false);
    });
  }

  it('narrows on type', () => {
    const msg = WsServerMessageSchema.parse(valid.find((m) => m.type === 'revealed'));
    if (msg.type !== 'revealed') throw new Error('expected revealed');
    expect(msg.tally).toHaveLength(2);
  });
});
