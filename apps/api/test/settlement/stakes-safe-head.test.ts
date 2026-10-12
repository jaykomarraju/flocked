// The close block and the safe head (W6-A pinned interface: src/chain/safe-head.ts) on a fake Base
// node: block n stamped t0 + 2n, the safe head `safeLag` blocks behind.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { publicClient } from '../../src/chain/client.js';
import { CloseBlockReorgedError, closeBlockFor, safeHeadPast } from '../../src/chain/safe-head.js';
import { FakeEscrowChain } from './stakes-chain.js';

const T0 = 1_800_000_000;

function setup(head = 1000) {
  const chain = new FakeEscrowChain(T0, head);
  return { chain, client: publicClient(env, chain.transport()) };
}

describe('closeBlockFor', () => {
  it('is null while the head is stamped before closesAt', async () => {
    const { client } = setup();
    expect(await closeBlockFor(client, T0 + 2 * 1000 + 1)).toBeNull();
  });

  it('is the last block stamped before closesAt, between blocks or on one', async () => {
    const { chain, client } = setup(1300);
    // Block 1100 is stamped T0 + 2200: closesAt one second later leaves it the close block.
    expect(await closeBlockFor(client, T0 + 2201)).toEqual({
      number: 1100,
      hash: chain.hashOf(1100),
      timestamp: T0 + 2200,
    });
    // A block stamped exactly at closesAt is past it (FlockedEscrow refuses entries from closesAt).
    expect((await closeBlockFor(client, T0 + 2200))?.number).toBe(1099);
    // The head itself can be the first block at or after closesAt.
    expect((await closeBlockFor(client, T0 + 2600))?.number).toBe(1299);
  });
});

describe('safeHeadPast', () => {
  it('is true only once the safe head is above the close block', async () => {
    const { chain, client } = setup(1300);
    const close = { number: 1290, hash: chain.hashOf(1290) };
    chain.safeLag = 10;
    expect(await safeHeadPast(client, close)).toBe(false);
    chain.safeLag = 9;
    expect(await safeHeadPast(client, close)).toBe(true);
  });

  it('throws when the close block is no longer canonical', async () => {
    const { chain, client } = setup(1300);
    const close = { number: 1290, hash: chain.hashOf(1290) };
    chain.reorgFrom = 1285;
    chain.reorgSalt = 1;
    await expect(safeHeadPast(client, close)).rejects.toBeInstanceOf(CloseBlockReorgedError);
  });
});
