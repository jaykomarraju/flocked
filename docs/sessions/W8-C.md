# W8-C handoff: Web shell + sign-in

## Status

complete: `apps/web` builds and serves the shell, onboarding and sign-in; the screenshot, axe and sign-in suites pass locally (fresh stack) and in CI; the e2e harness fixes and the two-phase rule for `ui` hold.

## Summary

- **apps/web** (Vite 8, React 19, react-router 8, wagmi 3 + viem, react-query, `@farcaster/miniapp-sdk`): the theme generated from `design-tokens.json` (`src/theme`: Paper's custom-property names, `.type-<role>` classes, light/dark by `prefers-color-scheme` or `data-theme`), self-hosted Inter and Fredoka variable fonts (`@fontsource-variable/*` 5.3.0, bundled), the typed API client over `ENDPOINTS` (`src/api/client.ts`), sessions (cookie in the browser, Bearer in the mini app; `src/auth/session.tsx`), SIWE through wagmi (an injected/EIP-6963 wallet, else Base Account, Coinbase Smart Wallet's successor), Farcaster (Quick Auth in the mini app; in a browser the relay plus Quick Auth's SIWF exchange), email codes, Turnstile.
- **Components** (`src/ui`, 40 files with Testing Library tests) matching all nine Components sheets; **mascot** placeholders (`packages/shared/src/mascot`: React-free pose data and `mascotSvg` from the index, `Mascot` at `@flocked/shared/mascot/react`).
- **Shell**: `ShellFrame`/`AppShell` (five tabs; You sheet on mobile, avatar menu from tablet up; offline banner; route errors in the shell), interim `Today` (skeleton, error with retry, empty state, or the round read-only), placeholders for later screens, the onboarding modal (first signed-out visit, hands off to sign-in) and the sign-in dialog (bottom sheet / modal).
- **Design sheets** under `/__sheets` (`--mode e2e` and dev only) redraw 38 artboards from the real components; every one matches its export within 0.5% (components ≤ 0.48%, mascot ~0%, onboarding and sign-in ≤ 0.06%).
- **e2e**: the `ui`/`ui-warp` projects, `fixtures/screenshot.ts`, three specs (52 tests: 38 `@screenshot`, 12 shell/onboarding screens with axe, 2 sign-in end to end on the stack), and the W7-Z harness fixes.
- **Paper**: the Foundations caption row (Inter 500, muted) and the nav-bar note ("nav label") fixed and re-exported; the `mono` token (decision E8).

## Branch and head commit

`w8-c-web-shell` @ `584f38b` (code); this handoff is the next commit.

## Files touched

- New: `apps/web/**` (incl. `.env.e2e`, `.env.development`: public values only), `packages/shared/src/mascot/**`, `packages/shared/test/mascot{,-react}.test.ts(x)`, `e2e/fixtures/screenshot.ts`, `e2e/ui/{shell,onboarding,sign-in}.spec.ts`, `e2e/ui/phases.test.ts`, `docs/sessions/W8-C.md`.
- Edited: `e2e/fixtures/{clock,http,index,user}.ts`, `e2e/playwright.config.ts`, `e2e/package.json`, `e2e/tsconfig.json` (`allowImportingTsExtensions`), `e2e/ui/README.md`, `e2e/stack/README.md`, `.github/workflows/e2e.yml`, root `package.json` (`e2e:ui`, `e2e:screens`), `pnpm-lock.yaml`, `packages/shared/{design-tokens.json,src/tokens.ts,test/tokens.test.ts}` (mono), `packages/shared/src/index.ts` (one line), `packages/shared/package.json` (exports `./design-tokens.json` and `./mascot/react`, `sideEffects: false`, React as an optional peer), `packages/shared/{tsconfig.json,vitest.config.ts}` (JSX tests), `docs/design/exports/{components/navigation__{light,dark},foundations/type__light}__desktop.png`.

## Tests run

| Command | Result |
| --- | --- |
| `pnpm check` (Node 22.23.1) | pass: node:test 20, abi 13, settle 66, tlock 176, shared 495, e2e 4 (phases), web 284, signer 19, api 950, forge 202 |
| `pnpm format:check` | pass |
| `pnpm stack:down && pnpm stack:up && pnpm e2e:ui && pnpm stack:down` | 52 passed (27 s) |
| CI run 38833445248 (`22ae941`, the handoff commit) | check, contracts, properties, static-analysis pass |
| E2E run 38830399295 (dispatch, `eb9860b`) | api pass; ui failed on Linux screenshots (1.5–2.4%), which led to the macOS `screens` job |
| E2E run 38832507218 (dispatch, `e71194f`; later commits are a build guard, the re-exports and docs) | screens (macos-15), ui (stack) and api pass |

No test was skipped, deleted or weakened.

## Traceability rows covered

- NFR-9 (accessibility, 🟡 advanced, not closed): axe, no serious or critical violations, in `e2e/ui/shell.spec.ts` › "shell screens" (each tab and a You page, mobile and desktop, with the You sheet), `onboarding.spec.ts` › "onboarding on a first visit" (each card), `sign-in.spec.ts` › "sign-in on the stack" (choose, email and code steps). The reveal's reduced motion stays W9-C's.

## Deviations

- **Screenshots run on macOS in CI**, not in the stack job: Linux Chromium draws text with FreeType and missed every sheet by 1.5–2.4% (run 38830399295); Paper exports with Chromium (Electron) on a Mac. `screens` (macos-15, `vite preview`, `pnpm e2e:screens`) runs the `@screenshot` tests; `ui` (stack) runs the rest. Tolerance unchanged.
- **Email codes are read from the stack's wrangler log** (Miniflare's send_email lines), not through the seam: there is no seam route and `apps/api` is out of scope (see Notes).
- **Inter's optical size is pinned below 16px** (13px → opsz 26, 14px → 28, from the tokens): Paper's 2x exports render it so, and auto misses the sheets by 4–7%. Playwright forces the device scale (`--force-device-scale-factor=2`, emulation alone thins 1.5px borders) and the exports' Display P3 profile.
- **The mascot React components live at `@flocked/shared/mascot/react`**; the index exports only React-free data, since the API Worker imports `@flocked/shared`.
- **Farcaster in a plain browser** works through the relay (beyond the prompt's mini-app scope) because the browser artboard offers it; it is unit-tested only (the relay is external and the stack's Quick Auth mock has no SIWF route).
- **Today is interim**: read-only round, "Seal my pick" disabled; W9-C builds entries. Header/You-page placeholders for later screens.
- Files beyond the listed scope (all needed by the listed work): `packages/shared/{package.json,tsconfig.json,vitest.config.ts}`, `e2e/tsconfig.json`, `e2e/ui/phases.test.ts` and e2e's `test` script (so the phase check runs in `pnpm test`).

## Spec issues

1. **Email code length and lifetime** (Core flow `core/sign-in/email-code/*`): "a 6-digit code … works for 10 minutes", but the API issues 8 digits for 5 minutes (`EMAIL_CODE_DIGITS`, `AUTH_SECRET_TTL_MS`). The app says 8 and 5; the sheet passes the artboard's values. Recommend fixing the artboard copy.
2. **Undrawn sign-in states**: the email address step and the browser Farcaster wait step have no artboard; W8-C drafted copy ("Sign in with email", "Email me a code"; "Approve in Farcaster", "Open Farcaster", "Waiting for your approval", "Cancel"). Recommend a design pass, and approval of the copy.
3. **Mode toggle check** (Oct 12 decision) is on the Components sheet but not on the Core-flow onboarding/sign-in/Today artboards (most of their remaining 0.03–0.06%). Recommend re-exporting those artboards with the check.
4. **Captions on the component sheets' notes** are Inter 400 ink (every sheet); only UI captions use the 500 muted role. Recommend leaving documentation notes as they are and saying so in `screens.md`.
5. Kit details to confirm or fix: error message weight 500 in Paper vs 600 in README; "Refunded" at 0 tracking (result role 0.02em); the ">99%" fill drawn at track − 24 (a ceiling mirroring the 24px floor, written nowhere); dark smug glint uses the light accent; 32px avatar ring 2px vs 1.5px; sign-in dialog titles Fredoka 700 (title role 600) and paddings off the kit (sheet 20/32 vs 16/28, modal 32/20 vs 24/28); no "Not now" on the choose, code and mini-app artboards; no unticked checkbox drawn; no Back on onboarding cards (ArrowLeft only); the navigation note lists Profile under You, the spec doesn't.
6. Paper export quirks for design sessions: half-pixel-tall artboards (995.5, 1245.5) export 0.25 px low with a half-transparent first row (keep artboards whole-pixel tall); the opsz rendering above may be a Chromium font-cache effect inside Paper, so a future re-export could change it.
7. `docs/design/README.md` "Screen conventions (Admin)" still says the design language has no monospace face (E8 added `mono`), and `screens.md`'s W7-C note says the type table still shows Inter 400 ink (now fixed). Paper has no `--font-mono` token yet.

## Open issues

- W9-C: the Today entry flow and WS client; show the crowd-history hint once W8-B serves it; drop the interim disabled CTA.
- The header shows "Sign in" while `/me` loads; the main chunk is 581 KB (179 KB gzip: wagmi, viem, React, router, schemas). Lazy-load wallets before W14's performance work.
- Mini app sign-in has no e2e (needs a host-frame harness; W11-D, with OA-11).
- If the macOS runner's text rendering ever drifts from the owner's Mac, `screens` fails; re-check before blaming the code.
- `auth/SignInIcons.tsx` could move to `ui/icons`.

## Notes for D and Z

- Registry: `apps/web/src/routes.tsx` (D-owned from now); nav constants live in `src/nav.ts`.
- Lockfile: `pnpm-lock.yaml` and root `package.json` changed (web deps, axe, scripts). On a conflict with W8-A's SDK, take both and re-run `pnpm install`. `packages/shared/package.json` changed too (exports, `sideEffects: false`, React optional peer).
- CI: `e2e.yml` now has `api`, `ui` (stack, `--grep-invert @screenshot`) and `screens` (macos-15); globalTimeout 40 min; uploads also on cancel. plan.md 4.3/4.6 need the `e2e:ui`/`e2e:screens` rows.
- The full local run is two stacks: `pnpm e2e` on one, `pnpm e2e:ui` on another; the `stack` fixture refuses a non-warp project after a warp (`.run/e2e/warped.json`).
- Server change worth having (apps/api, W8-D or later): a keyed seam route such as `GET /__test/email/last?to=` so tests stop reading wrangler's log.
- `pnpm test` now runs e2e's phase check (`playwright test --list`, ~6 s, no stack).
- Subagents: a feasibility experiment, the mascot, five component builders (A1–A5), the shell/onboarding builder (L1) and the sign-in builder (L2), about 2.5M tokens in all; the parent integrated, fixed cross-file issues and committed.
