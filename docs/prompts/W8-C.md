# Session W8-C: Web shell + sign-in

**Role:** build (UI). **Size:** M (split into `W8-C.2` if needed: the app scaffold, theme, fonts, components and their screenshot tests first; layout, onboarding, sign-in, the API client, the e2e harness items and the sign-in e2e second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions; 4.3's `pnpm e2e` row has the two-phase rule). Read nothing else in `plan.md`.
- `docs/plan/wave-8.md`: the intro, "Pinned interfaces", "W8-C", and the W8-C and "All" items of every "Carry-over" section (W2-Z and W7-Z).
- `docs/sessions/W7-Z.md` (wave-7 summary). W8-A, W8-B and W7-F1 run alongside you; don't edit their paths (`wave-8.md`, `docs/plan/wave-7.md` "W7-F1").
- Design (OA-D1, Foundations and Components, is **frozen**; the owner confirmed it on Oct 12, 2026 after W7-C's five kit fixes; OA-D2, the Core flow, is frozen too):
  - `Design_Language.md` (whole file); `docs/design/README.md`; `docs/design/screens.md`, only the Foundations and Components sections and the Core flow onboarding and sign-in rows; the matching PNGs in `docs/design/exports/{foundations,components,core}/`;
  - through the Paper MCP, only those artboards (load the guide first: `get_guide({ topic: "paper-mcp-instructions" })`);
  - `packages/shared/design-tokens.json` (the theme's only source; `type.caption.weight` is now 500, Oct 12).
- Code you build on: `packages/shared/src/api/**` (schemas and `ENDPOINTS`, `API_BASE_PATH`), `packages/shared/src/ws.ts`, `apps/api/src/routes/auth.ts` (SIWE, Farcaster Quick Auth, email code), `e2e/playwright.config.ts`, `e2e/fixtures/**`, `e2e/ui/README.md`, `e2e/stack/README.md` ("The test seam", "Playwright specs"), `.github/workflows/e2e.yml`.
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Client app"                                  # first paragraph, Onboarding row, navigation
  pnpm spec "Identity and personhood" --sub "Identities"  # sign-in methods
  pnpm spec "Non-functional requirements"                 # accessibility and performance bullets
  ```
  Changed in wave 7 (Decision log, Oct 12, 2026, W7-Z): `Design_Language.md` "Typography" (captions Inter 500 in `--muted`; a `mono` token for hashes and JSON) and "Shape and layout" (no switch component; destructive confirms keep the accent CTA with a verb label); "Client app" (a "RoundDO down" paragraph, for W9-C); "Identity and personhood" (suspended accounts, merges). Read the rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'W7-Z'`.

## Objective
Build the web app of `wave-8.md` "W8-C" in `apps/web` (new package, Vite + React + TypeScript): the theme from tokens (light and dark, `prefers-color-scheme`), self-hosted Fredoka and Inter, the component library matching the Paper Components page, the mascot placeholders (`packages/shared/src/mascot`, from the Paper `sheep/*` layers), layout and navigation (five tabs: Today, Archive, Boards, Rooms, You; Submit, Queue, Claims and Settings under You on mobile and in the avatar menu on tablet and desktop, no header links), the onboarding modal, sign-in (SIWE through wagmi + Coinbase Smart Wallet; Farcaster in the mini app via `@farcaster/miniapp-sdk` Quick Auth → Bearer; email code), the session-aware typed API client, global loading, error, offline and empty states, and the Playwright `ui` project with the screenshot helper. Also the W7-Z carry-over: the e2e harness fixes, two Paper text fixes and the `mono` token.

## Starting point
- Base: tag `wave-7`. Branch: `w8-c-web-shell`. Worktree: `../flocked-w8-c`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w8-c -b w8-c-web-shell wave-7
  cd ../flocked-w8-c && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/web/**` (new), `packages/shared/src/mascot/**` (new; export it from `packages/shared/src/index.ts`, one line);
  - `e2e/ui/*.spec.ts` (`shell`, `onboarding`, `sign-in`), `e2e/ui/README.md`, `e2e/fixtures/screenshot.ts` (new), and for the harness items below: `e2e/playwright.config.ts`, `e2e/fixtures/{clock,http,index}.ts`, `e2e/package.json` (an `e2e:ui` script and browser deps) and `.github/workflows/e2e.yml`;
  - `packages/shared/design-tokens.json` and its schema test, only to add the `mono` font token (decision E8);
  - in Paper, only two text fixes on the frozen kit (owner decisions, Oct 12): the Foundations type-table caption row (Inter 500, muted) and the Components nav-bar note renamed "nav label" (13/18 Inter 400 ink stays). Re-export what changes;
  - `pnpm-lock.yaml` and root `package.json` (the `e2e:ui` script) for the new package; name both in "Notes for D", which resolves lockfile conflicts with W8-A's SDK by re-running `pnpm install`.
- Must not touch: `apps/api/**`, `apps/signer/**` (a server change you need goes in "Notes for D"), W8-A's and W8-B's paths, W7-F1's files, `e2e/tests/**` (the API specs; except the trailing `clock.release()` calls if you choose that fix), `contracts/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`, and every Paper page except the two text fixes.

## Pinned interfaces
- `wave-8.md` "Pinned interfaces": the web layout (`apps/web/src/routes.tsx`, `ui/**`, `theme/**` importing `@flocked/shared/design-tokens.json` with no retyped values, `api/client.ts` over `packages/shared/src/api`, `auth/**`) and the screenshot tests (`e2e/ui/*.spec.ts` against `docs/design/exports/<surface>/…png`, `maxDiffPixelRatio` 0.01, fonts self-hosted, animations disabled; helper `e2e/fixtures/screenshot.ts`).
- The `ui` project in `e2e/playwright.config.ts`, under the **two-phase rule** (W7-D; plan.md 4.3): anvil's clock only moves forward and the escrow refuses `createRound` past opensAt, so any test that warps anvil runs in a later phase, after every round on that stack exists.

## Tasks
1. Create the worktree (above). Confirm `pnpm check` is green before you change anything.
2. The e2e harness first (W7-Z review), before any `ui` spec:
   - `ui` gets `grepInvert: /@warp/` and a `ui-warp` phase (`grep: /@warp/`); every warp phase runs after every non-warp phase sharing the stack (warp phases depend on `api` and `ui`), or `pnpm e2e:ui` runs on its own fresh stack. Pick one, document it in `e2e/ui/README.md` and `e2e/stack/README.md` "Playwright specs", and make CI follow it;
   - a Playwright `globalTimeout` under `e2e.yml`'s 45-minute job, so a stuck run still writes its report (or `if: failure() || cancelled()` on the upload steps);
   - the game clock never moves behind anvil after a warp: floor `warpTo`'s pin at wall time, or drop the trailing `clock.release()` in the three warp specs;
   - `fixtures/http.ts`: `retryable = init.idempotent ?? (GET or HEAD)`, with `idempotent: false` on the Coinbase OAuth callback (`fixtures/user.ts`), and a labelled timeout error.
3. Scaffold `apps/web` (Vite, React, react-router, wagmi + viem, `@farcaster/miniapp-sdk`), the theme from tokens, self-hosted fonts, the `mono` token.
4. The component library to match the Components page (light and dark), with Vitest + Testing Library tests and a screenshot per component sheet; the mascot placeholders.
5. Layout and navigation, onboarding, sign-in (browser and mini app), the API client with sessions and Bearer, and the global states. The two Paper text fixes, re-exported.
6. The `ui` specs: screenshots for every component and the onboarding and sign-in artboards; axe on each screen (no serious violations); sign-in end to end against the local stack (a test EIP-1193 provider backed by an anvil key for SIWE; the email code through the seam). Add `pnpm e2e:ui` to CI per your choice in step 2.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22). `pnpm stack:up && pnpm e2e && pnpm e2e:ui && pnpm stack:down` (or your documented order) green on a fresh stack.
- Required: component tests; screenshot comparisons for every component and onboarding/sign-in artboard; axe on each screen; the sign-in e2e; the harness fixes (a config check that each test runs in exactly one phase).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- `apps/web` builds and serves the shell, onboarding and sign-in; the screenshot, axe and sign-in suites pass locally and in CI; the harness rule holds for `ui`; the handoff is written.

## Constraints
- Never commit secrets. Don't edit the spec or the design language; record problems in the handoff. Don't fake owner actions.
- Screenshot drift from fonts: pin the font files and disable animations. A baseline that can't match within 0.01 is a design question for Z, not a reason to loosen the tolerance.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6.

## End of session
1. Commit, then `git push -u origin w8-c-web-shell`.
2. Write `docs/sessions/W8-C.md` from plan.md 3.2, then commit and push it.
3. End with your status and: "When W8-A, W8-B, W8-C and W7-F1 all report complete, start W8-D from `docs/prompts/W8-D.md`."
