# W1-A handoff: Repo scaffold, CI, shared skeleton

## Status

complete — workspace root, `pnpm spec`, `@flocked/shared` skeleton and CI are in; CI green.

## Summary

- pnpm workspace root (`apps/*`, `packages/*`, `e2e`) with strict ESM TypeScript base config, ESLint flat config (typescript-eslint recommended-type-checked for TS), Prettier, `.editorconfig`, `.nvmrc`, `.npmrc`.
- Root scripts `check`, `lint`, `typecheck`, `test`, `spec`, `format`, `format:check`.
- `scripts/spec-section.mjs` (`pnpm spec`): `## ` section, `--sub` bold block, `--list`, closest-match suggestions with exit 1; 20 `node:test` tests against a fixture.
- `@flocked/shared`: `src/enums.ts` (Mode, RoundKind, RoundStatus, ModeStatus, Category, Provider, UserStatus, NotificationEvent, plus `TERMINAL_MODE_STATUSES` and an `isOneOf` guard), `src/copy.ts` (BRAND terms, VOICE lines, `winLine`/`lossLine`), 13 Vitest tests pinning values to the spec.
- `.github/workflows/ci.yml`: install (frozen), lint, typecheck, test, format:check.
- `CLAUDE.md` (34 lines) and `README.md`.

## Branch and head commit

`w1-a-scaffold` @ `686248f` (before this handoff commit)

## Files touched

- New: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.nvmrc`, `.npmrc`
- Edited: `.gitignore` (added the listed ignores; kept `.DS_Store`, `node_modules/`)
- New: `scripts/spec-section.mjs`, `scripts/spec-section.test.mjs`, `scripts/fixtures/spec-fixture.md`, `scripts/README.md`
- New: `packages/shared/{package.json,tsconfig.json,vitest.config.ts}`, `packages/shared/src/{enums,copy,index}.ts`, `packages/shared/test/{enums,copy}.test.ts`
- New: `.github/workflows/ci.yml`, `CLAUDE.md`, `README.md`, `docs/sessions/W1-A.md`

## Tests run

| Command                                                        | Result                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm check`                                                   | pass (20 node:test + 13 Vitest)                           |
| `pnpm format:check`                                            | pass                                                      |
| Fresh clone: `pnpm install --frozen-lockfile && pnpm check`    | pass                                                      |
| `pnpm spec "Smart contract" --sub "Constants"`                 | prints the 4-bullet constants block                       |
| `pnpm spec "Nope"`                                             | exit 1, 5 suggestions                                     |
| Lint sanity (temp file with `any` member access)               | 4 errors reported, file removed                           |
| CI on `w1-a-scaffold` (runs 37690288903, 37690379383)          | success                                                   |

Tool versions installed: TypeScript 6.0.3, ESLint 10.12.0, typescript-eslint 8.71.1, @eslint/js 10.0.1, Vitest 4.1.11, Prettier 3.9.9, @types/node 20.19.43, globals 17.13.0. Node 20.19.5, pnpm 10.34.5.

## Traceability rows covered

None (no traceability row is assigned to W1-A).

## Deviations

- **Not latest stable for two tools.** TypeScript 7.0.2 is out but typescript-eslint 8.71 requires `typescript <6.1.0`, so TS is 6.0.3. Vitest 5 requires Node ≥22.12, so Vitest is 4.1.11 (Node 20.19 is our runtime). Revisit when typescript-eslint supports TS 7 or the Node floor moves.
- `tsconfig.base.json` uses `module: ESNext` with `moduleResolution: Bundler` (`module: Bundler` isn't a valid value). It sets `noEmit: true`; a package that builds (e.g. settle's `build`) overrides it.
- Imports inside packages are extensionless (Bundler resolution), not `.ts`, so packages can still emit later.
- `@flocked/shared` `exports` points at `./src/index.ts` (source, no build step). Consumers are Vite, Vitest and wrangler, which all handle TS.
- `pnpm lint` also lints `scripts/` (root `eslint scripts`), and `pnpm test` also runs `node --test scripts/*.test.mjs`.
- CI uses `actions/checkout@v7`, `actions/setup-node@v7` (version from `.nvmrc`), `pnpm/action-setup@v6`: the v4 majors raised a Node 20 deprecation warning. Added `concurrency` and `permissions: contents: read`.
- `.prettierignore` excludes `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/`, `contracts/` and `scripts/fixtures/`, so format checks never touch owner docs or byte-exact fixtures.
- Small extras in shared: `TERMINAL_MODE_STATUSES`, `isOneOf`, `winLine`/`lossLine` (templates of the two percentage voice lines; tests prove they reproduce the documented lines).

## Spec issues

- **"Modes: Free and Stakes" / P1.2:** `Mode` is defined both in `@flocked/shared` (this prompt) and in `@flocked/settle` (P1.2 `export type Mode`). Same values, but two definitions. Recommend: settle keeps its own (it must stay dependency-light), and a shared test asserts equality once D links them, or settle re-exports from shared. Z to decide.
- **Design_Language.md "Voice":** the win/loss lines contain example percentages (38%, 61%). I treated them as templates. If the copy should round or format differently (e.g. "<1%"), the spec should say.

## Open issues

- `pnpm spec` run from a package directory resolves to that package's scripts; use `pnpm -w spec` there (noted in CLAUDE.md).
- GitHub notes `ubuntu-latest` moves to Ubuntu 26 from Oct 19, 2026. No action expected; watch the first runs after that date.

## Notes for D and Z

- Root scripts: `check` = `pnpm lint && pnpm typecheck && pnpm test`. D appends `&& pnpm contracts:test` and adds `contracts:test` (`forge test --root contracts`) and later `contracts:build`. `lint`/`typecheck`/`test` use `pnpm -r --if-present`, so new packages are picked up automatically once their `package.json` has those scripts.
- CI: add a Foundry job/step (`foundry-rs/foundry-toolchain`, then `pnpm contracts:test`, `FOUNDRY_PROFILE=ci` if wanted). Note `pnpm test` runs from the root, so `forge` isn't needed in the JS job.
- ESLint: root `eslint.config.js` ignores `contracts/**`, `**/dist/**`, `**/out/**`, `**/coverage/**`, `**/node_modules/**`, `**/.wrangler/**`, `playwright-report/**`, `test-results/**`. TS files use `projectService`, so every TS file must be in some `tsconfig.json` `include` (settle's tests and vitest config too) or lint fails. When folding in settle: delete its local ESLint config and nested lockfile, have its `tsconfig.json` extend `../../tsconfig.base.json`, and keep `"types": ["node"]` only if it needs Node types in tests.
- Packages rely on root-hoisted devDependencies (`typescript`, `eslint`, `vitest`); settle can drop duplicates or keep them pinned to the same versions.
- `.gitignore` already covers `contracts/out/`, `contracts/cache/`, `contracts/dependencies/`.
