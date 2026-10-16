// The viem-backed reader and the HTTP source, against a fake JSON-RPC transport and a fake fetch.
// The real chain path runs end to end in W9-D's stack test (PIPE-6).
import { flockedEscrowAbi } from '@flocked/abi';
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  numberToHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { viemReader } from '../src/chain.js';
import { bundleUrl, httpSource } from '../src/source.js';

const ESCROW: Hex = `0x${'e5'.repeat(20)}`;
const player = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;

function enteredLog(roundId: bigint, n: number, block: number, logIndex: number) {
  return {
    address: ESCROW,
    topics: encodeEventTopics({
      abi: flockedEscrowAbi,
      eventName: 'Entered',
      args: { roundId, player: player(n), personTag: `0x${'00'.repeat(32)}` },
    }),
    data: encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes' }],
      [`0x${'00'.repeat(32)}`, numberToHex(n, { size: 4 })],
    ),
    blockNumber: numberToHex(block),
    logIndex: numberToHex(logIndex),
    transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
    transactionIndex: '0x0',
    blockHash: `0x${'bb'.repeat(32)}`,
    removed: false,
  };
}

describe('viemReader', () => {
  it('reads Entered logs in (block, log index) order, splitting ranges the RPC refuses', async () => {
    const logs = [
      enteredLog(7n, 3, 5000, 1),
      enteredLog(7n, 1, 1200, 0),
      enteredLog(7n, 2, 5000, 0),
    ];
    const ranges: [number, number][] = [];
    const request = ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_blockNumber') return Promise.resolve(numberToHex(6000));
      if (method === 'eth_getBlockByNumber') {
        const n = Number((params as [Hex])[0]);
        return Promise.resolve({
          number: numberToHex(n),
          timestamp: numberToHex(1_000 + n),
          hash: `0x${'cc'.repeat(32)}`,
        });
      }
      if (method === 'eth_getLogs') {
        const [{ fromBlock, toBlock }] = params as [{ fromBlock: Hex; toBlock: Hex }];
        const [f, t] = [Number(fromBlock), Number(toBlock)];
        if (t - f > 2_000) return Promise.reject(new Error('block range too large'));
        ranges.push([f, t]);
        return Promise.resolve(
          logs.filter((l) => Number(l.blockNumber) >= f && Number(l.blockNumber) <= t),
        );
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    };
    const client = createPublicClient({ transport: custom({ request }) }) as PublicClient;
    const reader = viemReader({
      rpcUrl: 'http://unused',
      escrow: ESCROW,
      anchor: ESCROW,
      deployBlock: 0n,
      client,
    });
    const got = await reader.entered(7n, 2_000n, 6_000n); // opensAt 2000 → block 1000
    expect(got.map((l) => [l.player, l.blockNumber, l.logIndex])).toEqual([
      [player(1), 1200n, 0],
      [player(2), 5000n, 0],
      [player(3), 5000n, 1],
    ]);
    expect(ranges[0]?.[0]).toBe(1000);
    expect(ranges.at(-1)?.[1]).toBe(6000);
    expect(ranges.every(([f, t]) => t - f <= 2_000)).toBe(true);
  });
});

describe('httpSource', () => {
  it('maps bundle keys to the API route or a bucket mirror; 404 is absent, other errors throw', async () => {
    const key = 'bundles/01ABC/free/chunk-0000.json';
    expect(bundleUrl('https://api.test/', key)).toBe(
      'https://api.test/rounds/01ABC/bundles/free/chunk-0000.json',
    );
    expect(bundleUrl('https://cdn.test', key, 'bucket')).toBe(`https://cdn.test/${key}`);
    const seen: string[] = [];
    const fake =
      (status: number): typeof fetch =>
      (url) => {
        seen.push(url instanceof Request ? url.url : url.toString());
        return Promise.resolve(new Response(status === 200 ? '{}' : null, { status }));
      };
    expect(await httpSource('https://api.test', { fetch: fake(200) })(key)).toEqual(
      new TextEncoder().encode('{}'),
    );
    expect(await httpSource('https://api.test', { fetch: fake(404) })(key)).toBeNull();
    await expect(httpSource('https://api.test', { fetch: fake(503) })(key)).rejects.toThrow(
      'HTTP 503',
    );
    expect(seen[0]).toBe('https://api.test/rounds/01ABC/bundles/free/chunk-0000.json');
  });
});
