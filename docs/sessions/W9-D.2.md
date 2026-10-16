# W9-D.2 handoff: Browser Free-round e2e; the W9-Z prompt

## Status
complete — `e2e/ui/free-round.spec.ts` proves E2E-1 (Free UI) and E2E-2 (UI) on a fresh stack and in CI's `ui` job;
W9-C's `reveal.spec.ts` flake is found and fixed; `docs/prompts/W9-Z.md` is saved. With W9-D (partial by design), wave
9's integrate work is done.

## Summary
- **The `reveal.spec.ts` flake (W9-D Open issue 2):** the mocked socket stamped `state` with the world's server
  time when the app connected, and on a slow runner it landed after `setPageTime` had jumped the page's clock an hour:
  `skewMs` ≈ −3,618 s for good, so the unsealing countdown sat at its 10:00 cap (CI's artifact: "Unsealing in10:00",
  24 polls over 10 s). Reproduced locally by delaying that first `state` 1.5 s (in order): 2 of 2 failed the same way.
  Fix (`e2e/ui/world.ts`): `setPageTime` re-sends `state` at the new time after the jump (`world.resync`); messages on
  one socket arrive in order, so the page's last skew is the fresh one. With the delay still in: 3 of 3 passed.
  Not the client's: a real server's stamp is never an hour stale.
- **`e2e/ui/free-round.spec.ts`** (project `ui`, no warp; five serial tests sharing one round and three browser
  contexts): sign in through the dialog with a test wallet; pick (option 0 against two on option 1) and a stake preset;
  seal; the round closes and reveals with nothing called after `POST /__test/rounds/scheduled`; each browser shows
  Sealed, "Unsealing in m:ss", "Counting the flock…", the reveal (33% / 67%, the winner's bar) and its own result card,
  which matches `GET /rounds/:id/me` (result, option, validity, the Won/Lost figure from its payouts). axe on Today,
  Sealed, unsealing and the reveal, in every browser. About 3.9 min.
- **`e2e/fixtures/browser.ts`** (new): W9-C's on-stack setup moved out of `today.spec.ts` (`preparePage`,
  `signInByCookie`, `pageRoundMe`), plus `newPlayerPage` (a context with the project's device, locale and zone),
  `installWallet` and `signInWithWallet`. `today.spec.ts`'s stack test now uses it, unchanged in what it checks.
- **`docs/prompts/W9-Z.md`** from plan.md 3.1 and 3.4 and the `wave-9.md` "W9-Z checklist".

## Branch and head commit
`w9-integration` @ `0029bdd` (code; `45781cd` the reveal fix); this handoff and `docs/prompts/W9-Z.md` follow.

## Files touched
- New: `e2e/ui/free-round.spec.ts`, `e2e/fixtures/browser.ts`, `docs/prompts/W9-Z.md`, this handoff.
- Edited: `e2e/ui/world.ts` (`resync`, `setPageTime`), `e2e/ui/today.spec.ts` (its stack test imports the fixture;
  see Deviations), `e2e/ui/README.md` (the spec table). No app code; `git diff audit-candidate-1 HEAD -- contracts/src`
  is empty.

## Tests run
| Command | Result |
| --- | --- |
| `gh run list --branch w9-integration` at the start (`05b0831`) | CI, Stack, E2E success (E2E attempt 1) |
| `reveal.spec.ts` "in the browser", first `state` delayed 1.5 s, before / after the fix | 2 failed ("Unsealing in 10:00") / 3 × 2 passed |
| reveal, sealed and Today browser tests against `vite preview`, `--repeat-each=3` | 24 passed |
| `free-round.spec.ts` alone on a fresh stack (final) | 5 passed (3.9 min) |
| `pnpm check` at `0029bdd` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 504, e2e phase check 4, web 334, signer 19, verify 46, api 1397, forge 202 |
| `pnpm format:check` | pass |
| `pnpm stack:up && pnpm e2e:ui && pnpm stack:down` (fresh stack) | 106 passed (7.6 min; W9-D's 101 plus the 5 new) |
| `pnpm stack:up && pnpm e2e && pnpm stack:down` (another fresh stack) | 34 passed (26.5 min) |
| `pnpm e2e:screens` (macOS) | 77 passed |
| CI on `0029bdd`: CI 38912163398, Stack 38912163544, E2E 38912163586 | all success on the first attempt; E2E `ui` 8.8 min (was about 4.9), `api` 27.9 min of the 40-min budget, `screens` 1.8 min |

## Traceability rows covered
- **E2E-1** (Free UI): `e2e/ui/free-round.spec.ts` › "E2E-1 Free UI: three players sign in in the browser with a
  wallet while the round is scheduled", "E2E-1 Free UI: each player picks and seals in the browser, and its receipt
  checks out (axe on Today and Sealed)". The row's "verify personhood" has no Free step: Free entry needs none, and the
  browser's personhood flow belongs to the Stakes UI (W10-D, `stakes-round.spec.ts`).
- **E2E-2** (UI): `free-round.spec.ts` › "E2E-2 UI: the round closes on its own, and each browser counts down to the
  unsealing (axe)", "E2E-2 UI: the beacon arrives; each browser counts the flock, then reveals the smaller side winning
  (axe)", "E2E-2 UI: each browser shows its own result, as GET /rounds/:id/me has it".
- NFR-9 (axe part): the same spec, every screen of the Free flow on the stack.

## Deviations
- **`revealed` is held 2 s in each browser:** "Counting the flock…" lasts from the page's first 1 s tick past beacon
  time to `revealed`, which was **61 ms** in a measured run, so a later tick would skip it and the test would flake.
  Each page's round socket goes through a Playwright proxy (`holdRevealed`, `connectToServer`) that passes the server's
  messages on in order and holds `revealed` 2 s. Nothing is faked; the round, its timing and every message are the
  stack's. See Spec issues.
- **The phase record skips a blank of a few ms at the close** (`phasesSeen` drops `none` and the repeat after it):
  Today shows a skeleton while it loads the round for its previous-round slot (Open issue 1). It isn't mine to fix.
- `today.spec.ts` isn't in my file list: its stack test now imports `fixtures/browser.ts`, which the prompt allows
  ("e2e/fixtures/\*\* only to share a helper with today.spec.ts"); its steps and assertions are unchanged.
- `installWallet` is a copy of `sign-in.spec.ts`'s (W8-C's file, not in my list); Open issue 2.
- A paused page clock in `setPageTime` (so countdowns can't drift) was tried and dropped: axe runs on the page's
  timers and hung. The page's clock keeps flowing as before.
- No test was skipped, deleted or weakened.

## Spec issues
- **"Real-time and the reveal" › Reveal choreography / "Client app" › Reveal:** "Counting the flock…" has no minimum
  display. On the stack the result arrives within about a second of beacon time, so the state flashes (61 ms
  measured) or is skipped, depending on where the client's tick falls; production's timing is likely similar.
  Recommend: hold the counting state at least ~1.5 s before the bars grow (the client keeps the result back that
  long), so every player sees it; then `free-round.spec.ts` can drop its proxy.

## Open issues
1. **Today blinks at the close (W9-C's code; W9-Z small fix or W10-C):** `GET /rounds/today` answers `round: null`
   and `previousRoundId` = the round once it closes (`read/rounds.ts`), so `TodayScreen` switches to its
   previous-round branch, whose `prevView` (`GET /rounds/:id`) isn't cached yet: `<Skeleton />` for one fetch (26 ms
   locally), then a new `PlayedRound` (a new socket, the skew reset). Fix: seed `prevView` with the round already on
   screen (`initialData` when the IDs match), with a `Today.test.tsx` case; then drop the filter in `phasesSeen`.
2. `e2e/ui/sign-in.spec.ts` can import `installWallet` from `e2e/fixtures/browser.ts` (W9-Z, small).
3. CI time: the `ui` job went from about 4.9 to 8.8 min (`free-round.spec.ts` is about 4 of them); `api` is 27.9 of
   its 40 min.
4. W9-D's open issues 1 (guardian void), 3 (the `api` job's time) and 4 (the timing-dependent SQL-cap kill) and its
   spec issues stand; the W9-Z prompt carries them.

## Notes for Z
- `docs/prompts/W9-Z.md` carries W9-D's and this session's issues, the W9-A, W9-B, W9-C and W8-F1 spec issues, the
  design subagent's list, and the wave-10 migrations (W10-A `0023`, W10-B `watcher/0001`, W10-D `0024`; `0022`
  unused).
- W10-D can build `stakes-round.spec.ts` on `fixtures/browser.ts` and this spec's shape (serial tests, three pages,
  the phase record).
- W9-D.2 used no subagents. Size: past M (about 0.26M tokens in its own context), mostly waiting on stack runs and
  diagnosing the two timing problems.
