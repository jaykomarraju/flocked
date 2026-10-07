# @flocked/abi

TypeScript ABIs (`as const`, for viem) and deployment addresses for the Flocked contracts. Everything under `src/`
except `addresses.ts` and `index.ts` is generated: don't edit it.

```ts
import { addressesFor, flockedAnchorAbi, flockedEscrowAbi, mockUsdcAbi } from '@flocked/abi';

const { escrow, anchor, usdc, deployBlock } = addressesFor(84532); // committed deployment
const local = addressesFor(31337, JSON.parse(localFileText)); // contracts/deployments/31337.json, read by the caller
```

| Command                                | Does                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm contracts:build` (root)          | `forge build` + `node packages/abi/scripts/gen.mjs`                                |
| `pnpm --filter @flocked/abi gen:check` | Fails if the generated files differ from `contracts/out` (CI, after `forge build`) |
| `pnpm --filter @flocked/abi fixtures`  | Re-signs `test/fixtures/receipt.json` with viem (used by `AnchorReceipt.t.sol`)    |
| `pnpm --filter @flocked/abi test`      | Generated files match the contract sources' hash; ABIs, addresses, receipt fixture |

`gen.mjs` uses only Node built-ins, so it runs in CI's Foundry job without `pnpm install`. Each generated file records
a sha256 of its inputs (`contracts/src/**/*.sol`, `MockUSDC.sol`, `soldeer.lock`, committed deployment files), so
`pnpm test` catches a stale package without compiling.
