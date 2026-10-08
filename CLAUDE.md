# Flocked

Flocked is a daily minority game: one question, two options, picks sealed by timelock until a
shared reveal, and the side fewer people picked wins. Free (points) and Stakes (USDC on Base) modes.

## How to work

- Work from your session prompt. The plan is `plan.md`; sections 2 (Protocol) and 4 (Global
  conventions) are the rules. Read only the parts your prompt names.
- Own worktree per session (`../flocked-w{n}-{x}`); never share a working directory.
- Stage files by name. Never `git add -A` or `git add .`.
- Never edit `Product_Spec.md`, `Design_Language.md`, `plan.md` or `docs/plan/` unless you are a
  Z session. Record spec problems in your handoff (`docs/sessions/W{n}-{X}.md`).
- No secrets in the repo, logs or chat. Local values go in `.dev.vars` / `.env.local`.

## Reading the spec

Never read the whole spec. Load one section at a time (from a package directory, use `pnpm -w spec`):

```bash
pnpm spec --list
pnpm spec "Smart contract" --sub "Constants"
```

## Commands

| Command                                 | Runs                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm check`                            | lint, typecheck, test, contracts:test (keep green before every commit) |
| `pnpm lint` / `typecheck` / `test`      | across every workspace package (and `scripts/`)                        |
| `pnpm contracts:build`                  | `forge build --root contracts` plus ABI codegen into `packages/abi`    |
| `pnpm contracts:test`                   | `forge test --root contracts` (unit, fuzz, invariant, vectors)         |
| `pnpm --filter @flocked/settle vectors` | regenerate settlement vectors (CI fails if they change)                |
| `pnpm --filter @flocked/tlock vectors`  | regenerate target-round vectors (CI fails if they change)              |
| `pnpm format` / `pnpm format:check`     | Prettier                                                               |
| `pnpm spec "<heading>" [--sub "<l>"]`   | one section (or bold block) of `Product_Spec.md`                       |

Fresh worktree: `pnpm install` and `(cd contracts && forge soldeer install)` before `pnpm check`. The CI
Foundry profile is `FOUNDRY_PROFILE=ci forge test` (Foundry 1.7 has no `--profile` flag).

Toolchain: Node 22.23 (`nvm use`; `engine-strict` rejects older), pnpm 10, TypeScript strict ESM, ESLint flat config, Prettier, Vitest (Workers tests via `@cloudflare/vitest-plugin`); Foundry 1.7.1
(Soldeer deps) for `contracts/`.
