# W9-C handoff: Web Today, Sealed, Reveal

## Status

complete (W9-C.2 done in the same session, at the owner's request): the whole Free flow works in the browser (a round
played on the stack up to the reveal), every Today, Sealed and Reveal state matches Paper, and every required test
passes.

## Summary

- **WS client** (`apps/web/src/ws`): one socket per round, "ping" keep-alive, jittered exponential reconnect; an
  idempotent, never-backwards reducer (`live.ts`: counts only grow, statuses only advance, duplicates and late
  fan-outs are no-ops); while the socket is down, a "Reconnecting…" banner and `GET /rounds/:id` polling (E7).
- **Free entry flow** (`apps/web/src/crypto`): `checkTargetRound` (daily and room rounds: 21:00 New York), the
  onchain lock leaf through the client's own public RPC (closesAt, beaconRound, questionHash, the Free config hash
  recomputed from the published config), tlock in the browser, POST with 503 retries and Turnstile on the New York
  day's first entry (and on 403 `turnstile_failed`), receipt checks (every field, `commitment` = keccak of its own
  ciphertext, the EIP-712 message rebuilt from its own values and recovered to the onchain `receiptSigner`), and
  the pick and receipt stored per user and round; a failed check is stored with the fields and the answer as evidence.
- **Today** (`features/today`): replaces W8-C's interim screen: stake presets and slider, the crowd hint per mode,
  Stakes hidden (`STAKES_UI_ENABLED`), live counts, sealing, refusals and 4xx in the error box (selection kept), DST
  notice. **Sealed** (`features/sealed`): the stored pick or "Pick not on this device", the receipt-mismatch box,
  "Reveal in", Remind me (opens Settings), Invite friends (share/copy the ref link).
- **Reveal** (`features/reveal`): unsealing (m:ss), "Counting the flock…", the 3 s bars with the shares counting up,
  the accent, the result card springing up, mascot motion, share preview and Share, "The next question is already
  live"; once per round per device; reduced motion skips to the end state with a fade; refunds by reason (copy table
  keyed by `RefundReasonName`), split kept for rules 1, 2, 3, 5. The previous round's reveal comes first, then a
  "Last round" strip; a shown reveal stays after `previousRoundId` drops at settlement.
- **Sheets** (39 artboards, all within 0.135%): `core/today/{open-signed-out,open-free,sealing,dst-notice}`,
  `core/sealed/{pick-known,pick-lost}`, `core/reveal/{unsealing,counting,win,loss,refund,mode-toggle,next-live}`, each
  at three breakpoints; the reveal sheets draw their notes bands (`sheets/core/NotesBand.tsx`). The Sealed and Reveal
  artboards lack the mode-toggle check the app draws: a flat 658 px (≤ 0.051%).
- **W9-C.2 fix:** a refunded mode's tally comes from `GET /rounds/:id` (the socket sends none, decision A2), so rules
  1, 2, 3 and 5 show their split and Share, as Paper draws them.

## Branch and head commit

`w9-c-today` @ `204ae3a` (code); this handoff is the next commit.

## Files touched

- New: `apps/web/src/{ws,crypto}/**`, `apps/web/src/features/{today,sealed,reveal}/**` (TodayView and its test
  moved here from `screens/`), `apps/web/src/sheets/core/{today,sealed,reveal}.sheet.tsx`, `NotesBand.tsx`,
  `apps/web/src/ui/icons/ArrowRightIcon.tsx`, `e2e/ui/{world,tlock-bundle.spec,
  today.spec,sealed.spec,reveal.spec}.ts`, `docs/prompts/W9-C.2.md`.
- Edited: `apps/web/src/screens/Today.tsx` (now a re-export, see Notes), `apps/web/src/sheets/core/frames.tsx`,
  `apps/web/src/ui/SplitBars.{tsx,module.css}` (`pick`: the "Your pick" pill; `display`: the count-up text),
  `apps/web/src/ui/OptionCard.module.css` (a disabled pick keeps its selected look while sealing, as Paper draws),
  `apps/web/src/test/setup.ts` (skips the DOM setup in `// @vitest-environment node` files),
  `apps/web/package.json` + `pnpm-lock.yaml` (`@flocked/tlock`, `@flocked/abi`, workspace).

## Tests run

| Command | Result |
| --- | --- |
| `pnpm check` at the start | web: 1 load timeout (5 s, two other sessions running); 284 passed alone |
| `pnpm check` at `204ae3a` (W9-C.2) | pass: node:test 20, abi 13, settle 66, tlock 176, shared 504, e2e 4, web 334, signer 19, api 1311, forge 202 |
| `pnpm format:check` | pass |
| `pnpm e2e:screens` (macOS, vite preview) | 77 passed (W8-C's 38 + Today 12 + Sealed 6 + Reveal 21) |
| fresh isolated stack (`COMPOSE_PROJECT_NAME=flocked-stack-w9c`, ports moved): `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` | 101 passed (3.8 min; a first `stack:up` hung in the CREATE2 deploy for 14 min, and a fresh one came up normally) |

New tests: `crypto/entry.test.ts` (24), `ws/{live,socket}.test.ts` (15), `features/today/Today.test.tsx` (19), and
13 browser tests plus 39 screenshots in `e2e/ui`.

## Traceability rows covered

- **TL-1** (browser half): `e2e/ui/tlock-bundle.spec.ts` › "TL-1: the production bundle encrypts in Chromium; the
  recorded signature opens it" (the Worker's `classify` opens it with the recorded quicknet round 32,870,075), and
  `e2e/ui/today.spec.ts` › "sign in, seal a pick, Sealed, then the reveal…" (the stack's Worker opens a browser
  ciphertext with the local beacon). Node: `crypto/entry.test.ts` › "opens with the recorded quicknet signature…".
- **NFR-9** (reduced motion): `e2e/ui/reveal.spec.ts` › "reduced motion: the end state at once, with a fade…";
  `Today.test.tsx` › "runs Sealed → unsealing … reduced motion fades to the end state". axe: `today.spec.ts` ›
  "signed out and signed in, with axe", `sealed.spec.ts` (both), `reveal.spec.ts` (each phase), the stack round.
- Receipt mismatch: `today.spec.ts` › "a receipt that fails its checks is shown and kept…"; `entry.test.ts` ›
  "receipt mismatches (kept as evidence)". E2E-1/E2E-2 Free UI stay W9-D.2's (`free-round.spec.ts`).

## Deviations

- **Split, then rejoined:** W9-C stopped as `partial` and emitted `docs/prompts/W9-C.2.md`; the owner had it done
  in the same session, so this handoff covers both.
- **The local chain's trusted values come from the page**: the stack's drand network and contracts are made per
  `stack:up`, after the web build, so non-production builds read `window.__FLOCKED_LOCAL_CHAIN__` (set by the specs
  from the stack's state). Base and Base Sepolia use quicknet, the committed deployment and `VITE_PUBLIC_RPC_URL` or
  the chain's public RPC; production builds never read the global.
- **`skipDailyClose`** (local chain only): the stack's rounds close a minute out, not at 21:00 New York, so the
  specs turn off that one check; the unit tests prove it for daily and room rounds.
- `Today.test.tsx`: "switches the counter with the mode" became "hides Stakes for now" (per prompt), "Seal my pick
  stays disabled" the entry-flow tests. `e2e/ui/world.ts` is a helper outside the listed files. Crypto unit tests
  run in Node (`// @vitest-environment node`): noble rejects jsdom's `Uint8Array` realm.

## Spec issues

1. **Draft copy** for owner approval: crowd hint days per category ("Food days", "Life days", "Tech days", "Money
   days", "Pop culture days", "Days like this"; Paper has only "Would-you-rather days"); refusals ("This round
   doesn't match its onchain record, so we won't seal your pick to it.", "This round's timelock doesn't check out…",
   "We couldn't reach Base to check this round…"); entry errors (already entered, balance, stake range, break, rate
   limit, Turnstile); the receipt-mismatch line; "Reconnecting…"; "Clocks go forward tonight".
2. **Win motion** ("the lone sheep walks off-screen") vs the end-state artboard, which shows the sheep: implemented as
   walk off, then fade back. Recommend the design pass says which.
3. **Today slider** (builder): Paper draws a fixed 49px fill and Inter 400 ink end labels; the app fills by value with
   the caption role (Oct 12). Under tolerance; fix in the design pass. Note spacing under the CTA differs between the
   Free note (−12) and the sealing note (content gap); the DST notice clock is a 24-grid icon not in the kit; the kit
   doesn't say a disabled pick keeps its selected look.
4. **"Remind me"** has no client flow yet (push subscribe is W9-A's API, Settings W12): it opens Settings.
5. The Free win figure waits for `GET /rounds/:id/me` payouts after `revealed` (shows "…" until then).
6. **Builders' design notes:** the Sealed/Reveal question is 28/32 mobile, 32/36 up (no role); "Counting the
   flock…" is Fredoka 600 28/36 (no role); counter rows are 28 tall (sheet: 40); "Refunded" at 0.02em vs the kit's 0
   (~1,700 px); refund band line 2 ends "Stakes returned."; the toggle check is missing on Sealed, Reveal, next-live.

## Open issues

- The Stakes reveal (`provisional`, the live mode toggle) waits for W10: `STAKES_UI_ENABLED` is false, so the
  `notPlayed` state is drawn only in the sheet.
- Bundle: tlock-js ships in the Today views' chunk (188 KB, 57 KB gzip); main chunk 404 KB (131 KB gzip). W14-B.
- Production needs `contracts/deployments/{8453,84532}.json` committed (W13/W14) before Free entries can be checked.
- Share uses `/s/:shareId` from `GET /rounds/:id/me` cards, else `/r/:id` (W10-A renders the cards).

## Notes for D and Z

- **Route (W9-D):** in `apps/web/src/routes.tsx` import `Today` from `./features/today/Today` and delete
  `apps/web/src/screens/Today.tsx` (a re-export kept only because routes.tsx is D-owned). No new routes.
- **Dependencies:** `apps/web/package.json` gains `@flocked/tlock` and `@flocked/abi` (workspace); lockfile changed.
- **W9-D.2:** `today.spec.ts` › "a Free round in the browser on the stack" already signs in by cookie, injects the
  stack's chain (`__FLOCKED_LOCAL_CHAIN__` with `skipDailyClose`), seals in the browser and waits for the reveal; reuse
  it (or move it into a fixture) for `free-round.spec.ts`.
- `ui/` edits outside the owned paths: `SplitBars` (`pick`, `display`), `OptionCard.module.css` (disabled pick), and
  `test/setup.ts`; `ui/icons/ArrowRightIcon.tsx` (new). Builders: three, serial (Today; Sealed and the waiting
  states; the result states), about 0.2M, 0.25M and 0.28M tokens.
