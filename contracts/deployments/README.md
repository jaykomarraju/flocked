# Deployments

`script/Deploy.s.sol` writes `<chainId>.json` here: `{ "escrow", "anchor", "usdc", "deployBlock" }`, where
`deployBlock` is the first block to scan for events (at or before the deployment transactions).

| File | Chain | Committed |
| --- | --- | --- |
| `84532.json` | Base Sepolia (staging) | yes, once deployed |
| `8453.json` | Base (production) | yes, once deployed |
| `31337.json` | anvil (local stack) | no, gitignored |

`@flocked/abi` embeds the committed files (`pnpm contracts:build` regenerates it); the local file is read at runtime.
