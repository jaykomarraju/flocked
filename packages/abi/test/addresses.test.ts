import { describe, expect, it } from 'vitest';
import { LOCAL_CHAIN_ID, addressesFor, committedDeployments, parseDeployment } from '../src/index';

const local = {
  anchor: '0x106066550B5D2c96dBC22e68694E1bC35F468FEB',
  deployBlock: 0,
  escrow: '0xAfbec55AF270df7Ac28Ab0F193551d5062Bd1083',
  usdc: '0x6C5fEB59fA3c506f2ae5a128586E1bf4CF76F916',
};

describe('addressesFor', () => {
  it('reads the local deployment the caller passes for anvil', () => {
    expect(LOCAL_CHAIN_ID).toBe(31337);
    expect(addressesFor(31337, local)).toEqual({ ...local, deployBlock: 0n });
    expect(() => addressesFor(31337)).toThrow(/31337\.json/);
  });

  it('throws for a chain with no committed deployment', () => {
    expect(committedDeployments[8453]).toBeUndefined();
    expect(() => addressesFor(8453)).toThrow(/chain 8453/);
    expect(() => addressesFor(84532)).toThrow(/chain 84532/);
  });
});

describe('parseDeployment', () => {
  it('rejects malformed files', () => {
    expect(() => parseDeployment(null)).toThrow();
    expect(() => parseDeployment({ ...local, escrow: '0x1234' })).toThrow(/escrow/);
    expect(() => parseDeployment({ ...local, anchor: undefined })).toThrow(/anchor/);
    expect(() => parseDeployment({ ...local, deployBlock: -1 })).toThrow(/deployBlock/);
    expect(() => parseDeployment({ ...local, deployBlock: '5' })).toThrow(/deployBlock/);
  });
});
