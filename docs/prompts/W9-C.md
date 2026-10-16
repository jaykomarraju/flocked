# Session W9-C: Web Today, Sealed, Reveal

**Role:** build (UI). **Size:** M (split into `W9-C.2` if needed: Today, the WS client and the Free entry flow first; Sealed, the reveal animation and their screenshots second). Subagents' tokens count toward the size: W8-C used about 2.5M across nine subagents, so keep builders few and serial. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-9.md`: the intro, "Pinned interfaces", "W9-C", and the W9-C and "All" items of every "Carry-over" section (W2-Z, W3-Z, W4-Z, W7-Z, W8-Z).
- `docs/sessions/W8-Z.md` (wave-8 summary) and `docs/sessions/W8-C.md` (the web shell you build on: theme, components, API client, sessions, the screenshot helper, the macOS `screens` job).
- `docs/design/screens.md` (core: Today, Sealed, Reveal rows), their exports under `docs/design/exports/core/`, and through the Paper MCP only those artboards. The Today artboards were re-exported on Oct 16 with the mode-toggle check (W8-Z); the Sealed and Reveal artboards don't draw it yet (W9-Z's design pass adds it), while the app's toggle does, so expect that region to differ within the tolerance and say so in the handoff. `Design_Language.md` (Motion). `e2e/ui/README.md` (the phase rule).
- Code you build on: `apps/web/src/{ui,theme,api,auth,layout}/**`, the interim `apps/web/src/screens/{Today,TodayView}.tsx` (W8-C: read-only round, disabled "Seal my pick"; you replace it), `packages/shared/src/{ws,api/rounds}.ts` (WS messages; `RoundsTodayResponse.crowdHint` per mode), `packages/tlock` (`@flocked/tlock`: `checkTargetRound`, encryption), `packages/abi` (`FlockedAnchor` lock leaf).
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Client app"                                   # Today, Sealed, Reveal rows; "Entry flow (Free)"
  pnpm spec "Sealed picks (timelock encryption)" --sub "Client requirements"
  pnpm spec "Real-time and the reveal" --sub "Reveal choreography"
  ```
  Changed in wave 8 (Decision log, Oct 16, 2026, W8-Z): "Client app" (the crowd-history hint is per mode), "API" (`GET /rounds/:id` shows `revealing` for a closed round's pending mode past beacon time; Reveal gating), "Real-time and the reveal" (the WebSocket `state` row), "Question pipeline" (the shared `isSingleEmoji` check, for W12-A). Read the rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'W8-Z'`.

## Objective
Build `wave-9.md` "W9-C": the Today screen (question, option cards, Free stake presets and slider, the mode toggle with Stakes hidden for now, countdown, live counts over the WS client, the crowd-history hint per mode, "Seal my pick"), the Free entry flow (target round and lock leaf through a public RPC, browser encryption, POST, receipt verification, local storage of pick and receipt, mismatches shown and kept as evidence), the Sealed screen, the unsealing countdown, "Counting the flock…", the reveal animation (3 s bars, accent on win, result card, mascot motion, `prefers-reduced-motion` fade, once per round), the mode toggle on reveal and "The next question is already live". Your Today replaces W8-C's interim screen.

## Starting point
- Base: tag `wave-8`. Branch: `w9-c-today`. Worktree: `../flocked-w9-c`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w9-c -b w9-c-today wave-8
  cd ../flocked-w9-c && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit: `apps/web/src/features/{today,sealed,reveal}/**`, `apps/web/src/ws/**`, `apps/web/src/crypto/**`, the interim `apps/web/src/screens/{Today,TodayView,Today.test}.*` (remove or reduce them once your Today replaces them), `apps/web/src/sheets/**` (sheets for your artboards), `e2e/ui/{today,sealed,reveal,tlock-bundle}.spec.ts`; `apps/web/package.json` for a needed dependency (with `pnpm-lock.yaml`; name it in "Notes for D").
- Must not touch: `apps/web/src/routes.tsx` (D-owned from wave 9: write the route changes in "Notes for D"); `apps/web/src/{ui,theme,api,auth,layout}/**` except a fix you name in the handoff; W9-A's, W9-B's and W8-F1's paths; `apps/api/**`; `.github/workflows/*`, root `package.json`, `e2e/playwright.config.ts` (a new project or setting goes in "Notes for D"); `contracts/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`, Paper and `docs/design/` (record design problems in the handoff).

## Pinned interfaces
- The WS client (W7-A): the first message is always `state`, possibly followed by catch-up events; send "ping" to keep a socket alive (answered "pong"); reconnect with jitter; treat events idempotently (a timed-out fan-out can deliver one twice, W7-F1 R5); `refunded.provisional` marks a Stakes refund proposal ("Final at" `finalAt`); a refunded mode's `state` has `result: null` and no reveal animation (decision A2).
- RoundDO down (decision E7): keep the last state with a "Reconnecting" banner and poll `GET /rounds/:id` until the socket is back; an entry POST answering 503 `unavailable` is retried. Past beacon time `GET /rounds/:id` will show `revealing` for a closed round's pending mode (W8-F1 builds it; until W9-D merges it, `pending`).
- The first Free entry of each New York game day sends `turnstileToken` (else 403 `turnstile_failed`). The unsealing countdown is m:ss. Refund lines come from a copy table keyed by `RefundReasonName`.
- Screenshot tests (`@screenshot`) run on macOS in the `screens` job (`maxDiffPixelRatio` 0.01, W8-C's helper); the rest of `e2e/ui` runs in the `ui` job on the stack. Any spec that warps the clock follows the two-phase rule (`e2e/ui/README.md`).

## Tasks
1. Create the worktree (above). Confirm `pnpm check` is green before you change anything.
2. The WS client and Today (counts, countdown, crowd hint, presets and slider, the toggle with Stakes hidden).
3. The Free entry flow: `checkTargetRound` and the lock leaf, encrypt, POST, verify the receipt (signer onchain and every field; commitment = keccak of own ciphertext), store locally, show and keep mismatches.
4. Sealed, unsealing, counting, the reveal animation and reduced motion, the next question.
5. Sheets and screenshot specs for every core-flow state you implement; axe on each screen.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22). `pnpm e2e:screens` green on macOS; `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` green on a fresh stack.
- Required: TL-1 (browser half: the production bundle encrypts in Chromium, and the Worker decrypts with a recorded signature); screenshot comparisons for every core-flow state you implement; the reduced-motion test (NFR-9 part); receipt-mismatch handling; axe checks.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- A Free round can be played in the browser against the stack up to the reveal, the required tests pass, and the handoff lists the route changes for W9-D.

## Constraints
- Never commit secrets. Don't edit the spec or Paper; record problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6.

## End of session
1. Commit, then `git push -u origin w9-c-today`.
2. Write `docs/sessions/W9-C.md` from plan.md 3.2, then commit and push it.
3. End with your status and: "When W9-A, W9-B, W9-C and W8-F1 all report complete, start W9-D from `docs/prompts/W9-D.md`."
