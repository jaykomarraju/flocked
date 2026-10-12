# W7-C handoff: admin console (design)

## Status

complete — the Oct 12 Paper fixes are applied and re-exported, and the Admin page has 41 states at desktop and
tablet (82 exports), every row in `review`.

## Summary

- **W5-Z fixes:** no "Questions" link on the 74 Core flow tablet/desktop headers or the navigation sheet;
  `security_notice` locked and always on in Settings › notifications; the Streaks board ranks the best stray streak
  (current streak as the caption, the accent pill only on the top live streak); the five kit fixes on Components
  (light and dark) and in the README.
- **W6-Z fixes (frozen Cards page):** flocked.xyz on all 63 card frames and the 7 share sheets; "@woolgatherer"
  replaces "@jay" in the share previews.
- **Admin page:** a kit (shells, named parts) and 41 states: live round, interventions (two-step void, refusal after
  close, retry, pause), schedule, queue, challenge window, settlement holds (`refund_vetoed` and `foreign_entry`
  releases), users, flags and config (every `config` key, `geo.stakes.age21` matching worked through), analytics,
  and global loading, error and forbidden, with empty states where the spec allows. The README gains "Screen
  conventions (Admin)"; `screens.md` gains `## Admin` and a record of each fix.

## Branch and head commit

`w7-c-admin-design`: the fixes at `626c1ce`, then the Admin page and this handoff (head: the handoff commit)

## Files touched

- Edited: `docs/design/README.md`, `docs/design/screens.md`; re-exported `docs/design/exports/core/*` (74),
  `components/*` (10), `social/boards__streaks__*` (3), `settings/notifications__list__*` (3), `cards/*` (70).
- New: `docs/design/exports/admin/*` (82), `docs/sessions/W7-C.md`.
- Paper: the fixes on `Core flow`, `Components`, `Social`, `Cards and notifications`; new page `Admin` (`p-6-0`).

## Tests run

| Command | Result |
| --- | --- |
| `pnpm lint`, `pnpm typecheck`, `pnpm test` (Node 22.23.1) | pass: node:test 20, abi 13, settle 66, tlock 176, shared 453, signer 18, api 844 (no code changed) |
| `pnpm format:check` | pass |
| Paper `find_nodes` | no "flocked.app" or "@jay" on Cards and notifications; no "Questions" on Core flow or Components; the dark Components sheets use only `--color-dark-*` (all six patterns empty, re-run on actions and lists) |
| Exports | 242 PNGs at 2x by `sips` (desktop 2240, tablet 1536, mobile 760, cards 2400×1260 / 2400×1600 / 2160×2160); 82 admin names match the pattern |

## Traceability rows covered

None assigned to W7-C (design). OA-D5 (the owner's Admin review) and OA-D2 (the Core flow freeze) are the owner's.

## Deviations

- Builder subagents (one per page for the fixes, a lead plus four builders for Admin, one serial exporter) did the
  Paper work (plan.md 2.8). Exports ran one call at a time.
- The Core flow and navigation-sheet header spacing was briefly set to 32/20 by a wrong brief, then restored to
  40/28. Only the "Questions" link changed.
- **Pause** reads "Blocks new Stakes entries only" (Smart contract), not the spec's "new entries only". Only the
  admin multisig unpauses, so "Unpause contract" is drawn disabled.
- **Geo lists apply at the next ticket**, not to "rounds locked after it": they are read per request
  (`readStakesConfig`), so `AdminConfigSchema`'s doc comment is wrong. Only fee defaults wait for the next lock.
- The schedule is a two-week agenda (a 7-column grid was too narrow). Edit config is a panel, not a modal.
- `live/degraded` shows the lock anchor `missing`: the commit can't be missing while entries are open.

## Spec issues

1. **Caption weight.** Foundations' type table reads "caption … Inter 400 · 13/18 · +0.01em" (ink), and
   `design-tokens.json` has `type.caption.weight: 400`. The Oct 12 decision says Inter 500, muted, and W7-C applied
   that to Components and the README. Recommend Z set the token to 500 with muted and have a design session update
   the Foundations row.
2. **Admin console › Interventions:** "pauses … blocks new entries only" should say Stakes entries. Should
   `/stakes/prepare` refuse tickets while paused? Recommend yes.
3. **Streaks pill.** It wraps the value slot (the best streak), so it equals the live streak only when the live
   streak is that player's best. Recommend the spec say what the pill shows otherwise (e.g. the current streak).
4. **Question pipeline:** Approve has no target status (recommend submitted → queued; Assign schedules); no
   `question_rejected` event carries the "reason shown to the author"; an empty house backlog at lock is undefined.
5. **`geo.deny`** has no `config` key or rule. It is drawn as "blocks both modes; wins over allow". The owner
   should confirm. `mode.free.enabled` is named in the spec, but nothing reads it.
6. **Dashboard metrics** need definitions: split quality (drawn as the smaller side's share), verification rate,
   D-n retention, and whether beacon → reveal is per mode.
7. **`settlement_holds`.** Its PK (round, mode, reason) means a second refund veto reopens a released row, so
   release history lives only in `audit_log`. Recommend reading history from `audit_log`, or adding a hold ID, and
   saying that `released_by` is the recording admin while the guardian's reference goes in the audit data.
8. Unspecified: what clients see while the RoundDO is down, and admin search matching (prefix or exact).
9. The design language has no monospace face (JSON and hashes use Inter) and no switch (the segment is used).
10. Destructive confirms use the accent CTA, as Settings does (W5-C open question 6, still open).

## Open issues

- **Owner, Cards (frozen):** the 7 share sheets still show the viewer's "J" avatar in the app header behind a
  "@woolgatherer" preview. Recommend "W", or accept that the viewer is the sharer.
- **Owner, Settings:** "6 of 9 on" counts `security_notice`. Keep it, or show "5 of 8 on".
- **Owner, Components:** nav-bar inactive labels are 13/18 Inter 400 ink, and a note calls them a "caption label".
  Recommend keeping ink 400 (they are labels) and renaming the note. The stake selector's cap line (14/20 Inter
  400) isn't a type role.
- **Owner, config placeholders:** the geo lists are placeholders for OA-21: allow GB, IE, GR, US-NJ, US-PA, US-MD,
  CA-ON; age21 US-NJ, US-PA, GR; deny CU, IR, KP, SY, UA-43.
- **Z, `screens.md` Freeze column:** the Components and Cards rows still read `review`, though plan.md 8.2 marks
  OA-D1 and OA-D4 ✅. W7-C didn't change them.

## Notes for D and Z

**Artboards the fixes changed** (for the OA-D2 and OA-D3 reviews): Core flow (OA-D2): every tablet and desktop
artboard (74), header only. Social (OA-D3): `social/boards/streaks/*`, `settings/notifications/list/*`. Components
(OA-D1): `components/{actions,stake-selector,lists,forms-overlays,navigation}/{light,dark}/desktop`. Cards (OA-D4):
the 63 card frames, `cards/share-sheet/{result-web,teaser-web}/*` and `result-mini-app/mobile`.

**Schema gaps for W11-A** (`packages/shared/src/api/admin.ts`):

- **Holds:** no endpoint. Add `GET /admin/holds` (roundId, gameDay, mode, reason, txHash, createdAt, releasedAt,
  releasedBy, release reason, guardianRef, auditId, and the open count for the badge) and `POST …/release` with
  `{ guardianRef, reason, fixDeployed }` (`refund_vetoed` only). Also missing: the void and entry counts on
  `void_rate`, `refundTimeoutAt` on `refund_vetoed`, and the foreign `Entered` time.
- **Live round:** `doHealthy` per object (RoundDO, SettlementDO, viewer shards) with a since time;
  `indexerLagSeconds` beside the blocks (the alert is in seconds); the paused state (`paused`, `pausedAt`,
  `pausedBy`); `opensAt` / `closesAt`, the beacon round, time and status; per-mode `proposedAt` /
  `challengeEndsAt`; structured settlement progress (done, total, startedAt); an as-of time on counts. Define anchor
  `missing` and `skipped`, document `void_after_close`, and decide whether the server enforces the typed void
  confirmation.
- **Reasons:** `RetrySettlementRequest`, `SetUserRoleRequest`, assign, approve and add house question carry none,
  though every action is audited.
- **Schedule:** each day lacks its config, `locksAt` / `opensAt` / `closesAt`, overrides and question author;
  document that `PUT /admin/schedule/:gameDay` creates a round beyond the 48-hour window; `EditRoundConfigRequest`
  lacks Free `presets` and `beaconDelay`, and its bounds are looser than `LOCKED_CONFIG_BOUNDS` (return field
  errors).
- **Queue:** `predictedSplit` says "option 0 share", but the spec means the larger option's share (0.5–1); add
  per-status and house-backlog counts; type `moderation` to the spec's fields.
- **Users:** balances per scope and the room list (adjust scope); `coinbaseCountry`, `mergedInto`, suspension time
  and reason; entries' `gameDay` and `voidReason`; the reason and actor on ledger `admin` rows (audit join).
- **Config:** `AdminConfigSchema` lacks `geo.stakes.age21` and a named `mode.stakes.enabled` (recommend
  `geo.stakesAge21` and typed `modes.{free,stakes}.enabled`, each mapped to its key); add a `geo.deny` key and
  `updatedAt` / `updatedBy` per key; replace the whole-config PUT (concurrent saves overwrite) with a per-key PATCH
  and `ifMatch`, with the kill switch on its own route; notification copy needs a title and body per channel and
  variant (`notify.copy.<event>`), with `security_notice` locked.
- **Analytics:** no endpoint. Recommend `GET /admin/analytics?days=7|30|90` with the KPIs and daily series.
- **Copy for Z:** no `packages/**` copy changed. The admin copy lives in the Paper artboards and the `screens.md`
  rows.
