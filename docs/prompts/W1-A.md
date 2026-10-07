# Session W1-A: Repo scaffold, CI, shared skeleton

**Role:** build. **Size:** M. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-1.md`: the intro, "Pinned interfaces" P1.2 (only to see which names you must NOT define) and P1.4, and section "W1-A".
- There is no earlier wave summary (wave 1).
- Spec sections. `pnpm spec` doesn't exist yet (you build it), so load each with:
  `awk '/^## <heading>$/{p=1;print;next} /^## /{p=0} p' Product_Spec.md`
  - "Overview" (only the Brand vocabulary table)
  - "Core game rules" (only "Question format")
  - "Round lifecycle" (only the status bullets near the top)
  - "Data model" (only the "Status enums" paragraph)
- `Design_Language.md`, section "Voice" only.

## Objective
Create the pnpm workspace root that every later session builds in: shared TypeScript, ESLint and Prettier config; the canonical commands; GitHub Actions CI; the `pnpm spec` section-extraction script with tests; a `packages/shared` skeleton (enums and brand copy only); and a short `CLAUDE.md` that orients every future session. Keep `packages/shared` to a skeleton.

## Starting point
- Base: tag `wave-0`. Branch: `w1-a-scaffold`. Worktree: `../flocked-w1-a`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w1-a -b w1-a-scaffold wave-0
  cd ../flocked-w1-a
  ```

## Scope and file ownership
- May create or edit: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.nvmrc`, `.npmrc`, `.gitignore`, `.github/workflows/ci.yml`, `scripts/spec-section.mjs`, `scripts/spec-section.test.mjs`, `scripts/README.md`, `packages/shared/**` (except `design-tokens.json`, which doesn't exist yet), `CLAUDE.md`, `README.md`, `docs/sessions/W1-A.md`.
- Must not touch: `contracts/` (W1-B), `packages/settle/` (W1-C), `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`, `docs/prompts/` (except saving nothing; you emit no prompts).

## Pinned interfaces
- Workspace globs `apps/*`, `packages/*`, `e2e`; root scripts `check`, `lint`, `typecheck`, `test`, `spec`, `format`, `format:check` (plan.md 4.3; W1-D adds `contracts:*`).
- `packageManager: "pnpm@10.34.5"`, `engines.node: ">=20.19"`.
- Toolchain per plan.md 4.2: TypeScript strict ESM, ESLint flat config + typescript-eslint, Prettier, Vitest.
- `@flocked/shared` must not define `VoidReason`, `RefundReason`, `OptionIndex` (owned by `@flocked/settle`, P1.2) or any zod API schema (W2-D).

## Tasks
1. Create the worktree.
2. Root config: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ES2022, `module`/`moduleResolution` Bundler, `verbatimModuleSyntax`), `eslint.config.js` (typescript-eslint recommended-type-checked where practical; ignore `contracts/`, `**/dist`, `**/out`), Prettier, `.editorconfig`, `.nvmrc` (`20.19`), `.npmrc` as needed. Extend `.gitignore` (`node_modules/`, `dist/`, `.dev.vars`, `.env*.local`, `.wrangler/`, `coverage/`, `contracts/out/`, `contracts/cache/`, `contracts/dependencies/`, `playwright-report/`, `test-results/`); keep `.DS_Store`.
3. `scripts/spec-section.mjs`: `pnpm spec "<## heading>"` prints that section of `Product_Spec.md`. `--sub "<bold label>"` prints one bold-labelled block within it, from `**Label**` to the next bold label at the same level or the next heading. `--list` prints all `## ` headings. An unknown heading exits 1 and prints the closest matches. It works from any cwd in the repo. Write tests with `node:test` (`scripts/spec-section.test.mjs`) against a fixture markdown file, run by root `pnpm test`.
4. `packages/shared` (`@flocked/shared`, private, ESM): `src/enums.ts` (Mode `free|stakes`; RoundKind `daily|room`; RoundStatus; ModeStatus incl. `settle_proposed`, `refund_proposed`; Category list; Provider; UserStatus; NotificationEvent list from the spec's Notifications table; read only that table with `awk` if needed), `src/copy.ts` (brand vocabulary terms and the Design_Language voice lines as constants), `src/index.ts`, Vitest tests pinning every enum to the spec's values, scripts `typecheck`, `lint`, `test`.
5. CI `.github/workflows/ci.yml`: on push and pull_request; ubuntu-latest; checkout; `pnpm/action-setup`; `actions/setup-node` (20, pnpm cache); `pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm format:check`.
6. `CLAUDE.md` (≤ 40 lines): Flocked in two lines; "Work from your session prompt; the plan is `plan.md` (sections 2 and 4 are the rules)"; canonical commands table; "Never read the whole spec: `pnpm spec "<heading>"`"; "Never edit `Product_Spec.md`, `Design_Language.md`, `plan.md` or `docs/plan/` unless you are a Z session"; "Stage files by name"; "Own worktree per session". `README.md`: short project intro and setup commands.
7. Run `pnpm install`, then `pnpm check` and `pnpm format:check`, and fix everything.
8. Commit in logical steps, then push `w1-a-scaffold` and confirm CI is green (`gh run list --branch w1-a-scaffold`, `gh run watch`).

## Tests and checks
- `pnpm install --frozen-lockfile && pnpm check && pnpm format:check` pass from a fresh clone of your branch (test this in a temp clone).
- `pnpm spec "Smart contract" --sub "Constants"` prints the constants block; `pnpm spec "Nope"` exits 1 with suggestions.
- CI green on the pushed branch.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations.

## Definition of done
- All W1-A deliverables in `docs/plan/wave-1.md` exist; the checks above pass; handoff written with the tool versions you installed (TypeScript, ESLint, Vitest, Prettier).

## Constraints
- No secrets anywhere. Don't edit the spec; record spec problems in the handoff.
- Stage files by name (never `git add -A`). Commits end with the attribution line from your system reminder.
- If you run low on context, stop at a green commit and follow plan.md 2.6 (handoff `partial` + `W1-A.2` prompt).

## End of session
1. Commit and `git push -u origin w1-a-scaffold`.
2. Write `docs/sessions/W1-A.md` from plan.md 3.2 (in "Notes for D", list anything W1-D must know: root script names, how `check` should grow, ESLint ignores). Commit and push it.
3. End with your status line and: "When W1-A, B and C all report complete, start W1-D from `docs/prompts/W1-D.md`."
