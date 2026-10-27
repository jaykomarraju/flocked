# Browser specs

Playwright's `ui` project (`e2e/playwright.config.ts`, W8-C) runs `e2e/ui/*.spec.ts` in Chromium against the web app
the local stack serves: the API Worker's assets binding serves `apps/web/dist` at `APP_ORIGIN`
(`http://localhost:8787`), so the app, its API and its cookies share one origin, as in production.

```bash
pnpm stack:up               # a fresh stack (see "Two phases" below)
pnpm e2e:ui                 # builds apps/web (build:e2e), then runs projects ui and ui-warp
pnpm stack:down
```

`build:e2e` is a production build in Vite's `e2e` mode: it adds the design sheets under `/__sheets` and takes
`apps/web/.env.e2e` (anvil's chain ID, Cloudflare's public always-pass Turnstile test site key). Build before
`stack:up` when you can; the stack only writes a placeholder page when `apps/web/dist` is missing.

| Spec                         | What                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.spec.ts`              | Every Components-page sheet and the mascot sheet, light and dark, against their exports; the shell's screens (each tab, the You sheet and avatar menu, loading, error, offline, empty) with axe                                                                                                                                                                                             |
| `onboarding.spec.ts`         | The three onboarding cards at mobile, tablet and desktop against `exports/core/onboarding__card-*`; the real modal on a first visit (cards, keyboard, "Sign in to play") with axe                                                                                                                                                                                                           |
| `sign-in.spec.ts`            | The sign-in artboards (browser, email code, mini app) at three breakpoints; sign-in end to end on the stack: SIWE with a test EIP-1193 wallet backed by a fresh anvil key, and an email code read from the stack's email log, with axe                                                                                                                                                      |
| `free-round.spec.ts`         | A full Free round on the stack (E2E-1 Free UI, E2E-2 UI; W9-D.2): three players sign in with a test wallet, pick and seal in their own browsers, and the round closes and reveals on its own; each sees Sealed, the unsealing countdown, "Counting the flock…", the reveal and its own result as `GET /rounds/:id/me` has it, with axe. Its browser players come from `fixtures/browser.ts` |
| `stakes-eligibility.spec.ts` | Stakes eligibility in a mocked world (AC-8; W10-C): an eligible player sees the round's fixed stake, an unverified one sees "Verify with Coinbase", and the verification sheet needs both boxes, with axe                                                                                                                                                                                   |
| `stakes-entry.spec.ts`       | The Stakes entry and global-state sheets against their exports, and the round config check in a mocked world (W10-C): a config the chain disagrees with is refused and nothing is sent                                                                                                                                                                                                      |
| `claims.spec.ts`             | The Claims sheets against their exports, and Claims in a mocked world (W10-C): the list, the ready total, the claim-open times and the confirm sheet, with axe                                                                                                                                                                                                                              |
| `stakes-round.spec.ts`       | A full Stakes round on the stack (E2E-1 Stakes UI, E2E-4 UI; W10-D.2): three players sign in with the smart-wallet stand-in (`installSmartWallet`), verify with Coinbase in the tab, and enter as one sponsored user operation; each sees its provisional result and Claims' "Opens h:mm"; in `ui-warp` (`@warp`) the round is final and each claims exactly what `/claims` lists, with axe |
| `stakes-veto.spec.ts`        | A guardian veto on the stack (E2E-5; W10-D.2, no warp): three players enter Stakes, the guardian vetoes the proposed settlement, each page redraws its result as a full refund, and each claims its stake back in one sponsored `claimRefund`, with axe                                                                                                                                     |

## Screenshots

`fixtures/screenshot.ts` `expectArtboard(page, '<surface>/<screen>/<state>/<breakpoint>')` opens the artboard's
sheet (`/__sheets/...`: the real components laid out as the Paper artboard), sizes the viewport to the artboard (its
2x export halved; the project renders at `deviceScaleFactor: 2`), waits for the self-hosted fonts, and compares with
`docs/design/exports/<surface>/<screen>__<state>__<breakpoint>.png` at `maxDiffPixelRatio: 0.01`, animations off.

- The exports are the baselines and only a design session writes them (`docs/design/README.md` "Exporting"):
  `updateSnapshots: 'none'`, so `--update-snapshots` can't overwrite one.
- Fonts are the pinned `@fontsource-variable/inter` and `@fontsource-variable/fredoka` files, bundled into
  `dist/assets` (`apps/web/src/theme/fonts.ts`).
- A diff over 1% is a design question for Z, not a reason to loosen the tolerance or mask a region.
- On a failure Playwright writes the actual, expected and diff images to `test-results/`.

Against a dev server instead of the stack (no API, so sheets only):
`cd apps/web && npx vite --port 5201`, then
`cd e2e && UI_BASE_URL=http://localhost:5201 pnpm exec playwright test --project=ui ui/shell.spec.ts -g option-card`.

## Two phases

The `ui` suite follows the two-phase rule of `e2e/stack/README.md` "Playwright specs" as a suite of its own: tests
that warp anvil are tagged `@warp` and run in `ui-warp` after every `ui` test; `pnpm e2e:ui` runs on a fresh stack,
never after `pnpm e2e` on the same one (the `stack` fixture refuses a non-warp project once anvil was warped).
`phases.test.ts` (in `pnpm test`) checks that every test lands in exactly one project. The first `@warp` UI test is
`stakes-round.spec.ts`'s last (W10-D.2). Run one spec's phases as `--project=ui <file>`, then
`--project=ui-warp --no-deps <file>`: with both projects at once, Playwright runs the whole `ui` suite as `ui-warp`'s
dependency and ignores CLI filters (CI's `ui` job runs the same two steps, each with `--grep-invert @screenshot`).
