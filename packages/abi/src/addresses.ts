import { committedDeployments } from './deployments';

export type Address = `0x${string}`;

/** One chain's deployment, as written by `contracts/script/Deploy.s.sol` to `contracts/deployments/<chainId>.json`. */
export interface Deployment {
  readonly escrow: Address;
  readonly anchor: Address;
  readonly usdc: Address;
  /** First block to scan for events: at or before the deployment transactions. */
  readonly deployBlock: bigint;
}

/** anvil's chain ID. Its deployment file is gitignored and read at runtime, in local only. */
export const LOCAL_CHAIN_ID = 31337;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function address(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !ADDRESS.test(value)) {
    throw new Error(`deployment: ${field} is not an address`);
  }
  return value as Address;
}

/**
 * Validates a parsed deployment file (`{ escrow, anchor, usdc, deployBlock }`).
 * @throws if a field is missing or malformed.
 */
export function parseDeployment(json: unknown): Deployment {
  if (typeof json !== 'object' || json === null) throw new Error('deployment: not an object');
  const d = json as Record<string, unknown>;
  const block = d.deployBlock;
  if (typeof block !== 'number' || !Number.isSafeInteger(block) || block < 0) {
    throw new Error('deployment: deployBlock is not a block number');
  }
  return {
    escrow: address(d.escrow, 'escrow'),
    anchor: address(d.anchor, 'anchor'),
    usdc: address(d.usdc, 'usdc'),
    deployBlock: BigInt(block),
  };
}

/**
 * The contract addresses on `chainId`.
 *
 * Base Sepolia (84532) and Base (8453) come from the committed deployment files. The local chain (31337) is
 * redeployed with every stack, so the caller passes the parsed `contracts/deployments/31337.json` as `local`.
 * @throws for a chain with no deployment, or for the local chain without `local`.
 */
export function addressesFor(chainId: number, local?: unknown): Deployment {
  if (chainId === LOCAL_CHAIN_ID) {
    if (local === undefined) {
      throw new Error('chain 31337: pass the parsed contracts/deployments/31337.json as `local`');
    }
    return parseDeployment(local);
  }
  const d = committedDeployments[chainId];
  if (!d) throw new Error(`no Flocked deployment on chain ${chainId}`);
  return d;
}
