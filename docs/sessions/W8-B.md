# W8-B handoff: Stats, streaks, boards, referrals

## Status
complete — stats, streaks, the four boards, profiles, referrals, `GET /me/referrals` and the crowd hint, with the post-final hook registry; the Stakes call is W8-D's (below).

## Summary
- `src/settlement/hooks.ts`: `onModeFinal(handler)` / `runModeFinal(env, event)`. Free apply and Free refund call it last (`apply/free.ts`); every handler runs, failures are logged and rethrown so the caller retries. Stats and referrals are registered there.
- `src/stats/apply.ts`: `user_stats` from final daily outcomes only, applied **strictly in game-day order per mode** (`stats_days`): a mode that becomes final late holds later days back, then they apply in order. Entrants go in user-ID chunks; each batch is conditional on the day's cursor, so retries and concurrent calls count every entrant once. The stray streak and its best change in one `UPDATE` (the CHECK).
- Streak rules: settled win +1 / loss or invalid entry → 0; refunded and voided days neutral for the stray streak (entered or not), an entry still counts as played; absent on any day with a round ends the play streak (absent on a settled day ends both); no daily round, or no row for that mode, is not in the sequence (neutral for both). Game day = New York date of `closes_at`.
- `src/boards/`: strays (per game day, from the winners' snapshot `stats_wins`), streaks (`user_stats`), weekly (`stats_weeks`, ISO week of the game day), creators (mean split quality of used questions, min 2, from revealed final tallies). Tie-breaks per spec; full ties share a rank; mode filter; listed = active + person ID + `kyc_status` verified (merged, deleted, suspended and unverified never appear); `me` row with its rank.
- `GET /users/:handle` (`src/stats/profile.ts`), `GET /me/referrals` (`src/referrals/read.ts`), referral qualification and reward (`src/referrals/reward.ts`), the crowd hint on `GET /rounds/today` (`readCrowdHint` in `src/read/rounds.ts`).

## Branch and head commit
`w8-b-stats` @ `def6f2c` (code; this handoff is the next commit)

## Files touched
- New: `apps/api/migrations/0018_stats.sql`; `apps/api/src/settlement/hooks.ts`; `src/stats/{apply,profile}.ts`; `src/boards/{read,split}.ts`; `src/referrals/{reward,read}.ts`; `apps/api/test/stats/{helpers,streaks,hooks,profile,crowd-hint,free-wiring}.test.ts` (helpers is `.ts`); `test/boards/{boards,pill-and-net}.test.ts`; `test/referrals/referrals.test.ts`.
- Edited: `src/routes/{boards,users}.ts` (stubs replaced); `test/read/rounds.test.ts` (two expectations); `src/routes/me.ts` (only the `GET /me/referrals` handler and its import); `src/settlement/apply/free.ts` (only the two `runModeFinal` calls and the header); `src/read/rounds.ts` (only the crowd hint); `packages/shared/src/api/{boards,rounds}.ts` and their fixtures; `test/migrations.test.ts` (0018); `test/routes.test.ts` (two IMPLEMENTED rows, the `/users/:handle` 404).

## Tests run
| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile && pnpm check` (Node 22.23.1), at the start | pass |
| `pnpm check` at `def6f2c` | pass: node:test 20, abi 13, settle 66, tlock 176, shared 471, signer 19, api 1002, forge 202 |
| `pnpm format:check` | pass |
| `vitest run test/stats test/boards test/referrals` | 8 files, 49 passed |
| Mutation check (scratchpad script: one string replacement per guard, the owning test file, then `git checkout`) | 34 mutations, 33 caught; the miss is equivalent (`statsOnModeFinal`'s `kind` early return duplicates the day query's `r.kind = 'daily'`, whose mutation is caught). The first run's 5 misses tightened three tests (a person ID without verified KYC, a refunded mode with a recorded winner, direct `qualifyReferrals` calls) |

## Traceability rows covered
None are assigned to W8-B in `docs/plan/traceability.md`. The required tests: streak rules (`test/stats/streaks.test.ts`: "refunded and voided days neither break nor extend…", "a game day with no daily round is neutral…", "fall back (Nov 1, 2026)…", "spring forward (Mar 14, 2027)…", "a day that becomes final late holds the later days back…"); tie-breaks (`test/boards/boards.test.ts`, one test per board; `pill-and-net.test.ts`); verified-only boards excluding merged and deleted (`boards.test.ts` › "no board lists an unverified, merged or deleted account"); referral cap and qualification (`test/referrals/referrals.test.ts` › "rewards at most 10 per inviter per ISO week…", "qualifies on the invitee's first valid Free entry…", "an invalid entry, a refunded round, a room round and Stakes never qualify"); hook idempotency (`test/stats/hooks.test.ts` › "a retried hook call changes nothing", "concurrent calls over small chunks…", "a batch that fails halfway through a day is resumed…"; `referrals.test.ts` › "gives both users 100 global points once…").

## Deviations
- New tables and columns beyond the spec's data model (migration 0018): `stats_days`, `stats_wins`, `stats_weeks`, `referrals.reward_week`, `referrals.checked_at` (spec issue 1).
- Interface additions (for Z; optional or nullable for clients): `RoundsTodayResponse.crowdHint` (`{free, stakes}` of `CrowdHint | null`, null without a round; required field), `CrowdHintSchema`; `LeaderboardRow.topLiveStreak?: true`. Doc comments on `LeaderboardQuery` (default period, `bad_request` for the wrong period kind) and `LeaderboardRow` (streaks tie order, shared ranks, Stakes net).
- `test/routes.test.ts` (not in my paths, but its comment asks owners to add their rows) gains my two rows and accepts the profile's "No such user" 404.
- `test/read/rounds.test.ts` (W6-D's): its two schedule-gap `toEqual`s now include `crowdHint: null` (the new field); nothing else changed. The full check also showed its settled-round test failing on a hook: that file marks a daily round `settled` with no settlement record, which made the stats handler throw and wedged the next settlement. The handler now stops at such a day and raises `ALERT_DO_ERROR` (`step: 'stats_blocked'`) instead of throwing (`hooks.test.ts` › "a settled day without its settlement stops the stats and alerts…").
- Nothing skipped or weakened. `test/me/me.test.ts` › "GET /me/referrals … until W8-B" still passes unchanged (W7-F1's file).

## Spec issues
1. "Data model": add `stats_days`, `stats_wins`, `stats_weeks` and the two `referrals` columns (or describe them as derived tables). Recommend adding them.
2. "Game day and streaks": a voided entry counts as played like a refunded one, and being absent on a refunded or voided day ends the play streak (only a day with no round is neutral for it). Recommend stating it; the alternative is to make voided days neutral for the play streak too.
3. Same section: an invalid (VOID) entry on a settled day counts as played and refunded but ends the stray streak (otherwise a garbage entry could pause a streak). Recommend a line.
4. "Referral": "both users then get 100" with the farming rule means the invitee is usually under 24 hours old when it qualifies. Implemented: a qualified referral is rewarded (both users in one batch) at the first later daily Free result at which both pass the rule; it waits as `qualified` until then. Recommend saying so.
5. Same: a referral over the weekly cap waits and is paid in a later week (at most 10 per week), keyed by the ISO week of the game day whose result pays it. Recommend confirming (the alternative is to never pay it).
6. Same: the 7-day attribution window lives in the client (`ref` is carried into signup; W3-A inserts the pending row). The server can't check its age. W8-C/W10 keep `?ref=` (and `/s/:shareId`) for 7 days.
7. "Client app" (crowd hint): implemented per mode (Free and Stakes tallies separately). Recommend "per mode".
8. "Leaderboards": suspended accounts are not listed (profiles stay readable). Stakes weekly rows omit `net` unless the user shows it, yet still break ties by it. The default period is the latest game day whose results are counted (or its week), not the calendar day. Recommend confirming all three.
9. "Profiles": authored questions shown are `queued` ones and `used` ones whose round has opened (a used question is locked before its round opens; a scheduled one is never shown). Split quality comes from the Free tally, else Stakes. Recommend a line.
10. "Merging accounts": `user_stats`, `stats_*` and referrals stay with the merged-away account (never shown). Recommend deciding whether the kept account inherits them.

## Open issues
- A reorged-out Stakes `RoundFinalized`/`RoundRefunded` (W6-F1 R3 undo) does not undo applied stats or referral points. The indexer works at the safe head, so this is rare; W13-B or a later fix session could re-derive a mode's day.
- Handles are lowercase (`HandleSchema`), so `/users/Woolly` is 400: the web should lowercase before linking (W8-C).
- A voided day is applied only when a later day's hook runs (the void path doesn't call `runModeFinal`); W8-D may add the call (below).

## Notes for D and Z
- **Stakes `onModeFinal` (W8-D):** call `runModeFinal(env, { roundId, mode: 'stakes', kind, outcome })` for `RoundFinalized` (settled) and `RoundRefunded` (any reason but 4, `refunded`) in `src/indexer/handlers/stakes.ts`. Those handlers *return* their D1 statements, so the call must run **after** the indexer core commits them (the stats read `round_modes.status` and `payouts`). A throw must make the event retry; every handler is idempotent. `kind` comes from `rounds.kind` (room rounds are ignored by both handlers).
- Optional: `src/lifecycle/void.ts` could call `runModeFinal` per voided mode after confirmation.
- **W8-A's creator handler:** add `onModeFinal(<handler>)` at the bottom of `settlement/hooks.ts`. Creators board reads split quality from tallies itself (`src/boards/split.ts`, the spec formula); if W8-A stores split quality, either may read the other.
- `hooks.ts` and everything it imports must stay free of `cloudflare:workers` (the e2e indexer test imports `src/indexer/**`).
- No registry changes: `routes/{boards,users}.ts` keep their export names.
- Merge conflicts to expect: `test/migrations.test.ts` (0017, 0020 also add columns/tables), `routes/me.ts` (W7-F1 edits other handlers; mine is the referrals handler and one import line).
