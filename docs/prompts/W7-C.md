# Session W7-C (design): admin console

**Role:** design. **Size:** M (split into `W7-C.2` if needed: the Paper fixes on Components, Core flow, Social and Cards and notifications, with their re-exports, first; the `Admin` page second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 5.4 (Design track and freezes). Read nothing else in `plan.md`.
- `docs/plan/wave-7.md`: the intro, "W7-C", and the W7-C and "All" items of every "Carry-over" section (W5-Z, W6-Z).
- `docs/sessions/W6-Z.md` (wave-6 summary).
- Design files:
  - `docs/design/README.md`: pages, artboard names, exports, the contrast rules, the component and screen conventions, "Paper MCP notes";
  - `docs/design/screens.md`: the inventories and decisions, especially the Components, Core flow, Social, Settings and Cards and notifications sections you change;
  - `Design_Language.md` (whole; "Share cards" changed on Oct 12).
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Admin console"
  pnpm spec "Analytics" --sub "Dashboard metrics"
  pnpm spec "Compliance and responsible play" --sub "Geo-fencing"   # the lists the config screen edits
  pnpm spec "Compliance and responsible play" --sub "Age and terms"
  ```
  Changed in wave 6 (Decision log, Oct 12, 2026): "Share cards and distribution" (the domain is `flocked.xyz`; long questions step down 4 px, floors 32 and 56 px), `Design_Language.md` "Share cards" (the accent also marks the streak pill and the smug sheep's glint), "Compliance and responsible play" (Age and terms: `geo.stakes.age21` region rules and the unknown-region rule), "Round lifecycle" (refund_proposed → revealing opens a `refund_vetoed` hold the guardian releases) and "Data model" (`settlement_holds` reason `refund_vetoed`). The W5-Z fixes follow the earlier Oct 12 rows on "Client app" (Navigation), "Notifications" and "Profiles, leaderboards and rooms" (Leaderboards). Read them: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 12'`.
- What the screens show: `packages/shared/src/api/admin.ts` (the drafted `/admin/*` shapes, `AdminConfigSchema`), the `config` keys in `apps/api/src/personhood/config-store.ts` (`geo.stakes.allow`, `geo.stakes.age21`, `mode.stakes.enabled`), and `settlement_holds` in `apps/api/migrations/0008_settlement.sql`.

## Objective
First apply the owner's Paper fixes (Oct 12), re-exporting what they touch:
- W5-Z: no "Questions" header link on the Core flow tablet and desktop headers (74 artboards) or the navigation sheet; `security_notice` as a locked, always-on row in Settings › notifications; the Streaks board ranks the best stray streak with the current one as the caption, and the accent pill marks only the board's top live streak; the five kit fixes on `Components` and in `docs/design/README.md`;
- W6-Z: on the frozen page `Cards and notifications`, "flocked.app" becomes **flocked.xyz** on every card, share page and email, and the "@jay" handle in the share previews becomes a sample handle.

Then design the admin console at `desktop` and `tablet`: the schedule calendar with config editing until lock; the question queue (moderation JSON, predicted split warning, approve, reject with reason, edit wording, add a house question); the live round (status per mode, counters, DO health, indexer lag, anchor status, safe-head lag, settlement progress); interventions (void before close with a two-phase confirmation, retry settlement, pause) with confirmations; the challenge window list with watcher verdicts; users (search, suspend, identities, merges, entries, ledger, role, manual adjustment with reason); flags and config; and the analytics dashboard tab. Two screens need care:
- **flags and config** covers every key of the `config` table, including `geo.stakes.age21` (whole-country `CC` and region `CC-RR` entries, and what an unknown request region means), the Stakes kill switch, geo lists, fee defaults and notification copy;
- **settlement holds:** open holds (`foreign_entry`, `void_rate`, `refund_vetoed`) with the release that records the guardian's decision (`released_by`, a reason, an audit row). For `refund_vetoed`, show that release lets the coordinator propose again, and the `refundTimeout` backstop at closesAt + 72 h.

## Starting point
- Base: tag `wave-6`. Branch: `w7-c-admin-design`. Worktree: `../flocked-w7-c`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w7-c -b w7-c-admin-design wave-6
  cd ../flocked-w7-c && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
- First step: confirm the Paper MCP tools are visible, load their guide (`get_guide({ topic: "paper-mcp-instructions" })`), and open the file "Flocked" (`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`). If they're missing, stop as `blocked`.

## Scope and file ownership
- May create or edit:
  - Paper page `Admin` (new);
  - on `Components`, `Core flow`, `Social` and `Cards and notifications`: only the fixes in the Objective;
  - `docs/design/screens.md`: the admin section (new) and the rows the fixes change;
  - `docs/design/exports/admin/**` (new), and the existing exports the fixes change under `docs/design/exports/{components,core,social,settings,cards,notifications}/`;
  - `docs/design/README.md`: the five kit fixes, and the conventions the admin surface needs;
  - `docs/sessions/W7-C.md`.
- Must not touch: application code, every `packages/**` file (including `design-tokens.json` and `copy/**`; a copy change goes in the handoff for Z), the `Foundations` page, artboards no fix names, `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- P2.3 (`docs/plan/wave-2.md`): the Paper page names; artboard names `<surface>/<screen>/<state>/<breakpoint>` (surface `admin`, breakpoints `desktop` and `tablet`); exports at `docs/design/exports/<surface>/<screen>__<state>__<breakpoint>.png` (2x); inventory rows in `screens.md`.
- The tokens are frozen (OA-D1). Use only existing tokens and components; a missing one is a spec issue for Z.
- Frozen surfaces (Components, OA-D1; Cards and notifications, OA-D4) change only as the owner decided. Their rows stay `frozen`; record each change in `screens.md`'s decisions.
- The admin screens show what `packages/shared/src/api/admin.ts` carries (W11-A builds the endpoints). Where a screen needs data no schema has (the hold release, DO health), draw it and list the gap for W11-A; don't invent enum values.

## Tasks
1. Create the worktree, and confirm Paper (above).
2. The W5-Z fixes, re-exported. Check each Core flow header after the change, and update the affected `screens.md` rows.
3. The W6-Z fixes on `Cards and notifications`, re-exported; `screens.md` to match.
4. The `Admin` page: every screen in the Objective at `desktop` and `tablet`, with empty, loading, error and confirmation states, and refusals the spec names (no void after close).
5. Flags and config, and the settlement holds, as in the Objective.
6. The analytics dashboard tab from "Dashboard metrics".
7. Inventory rows marked `review`; the admin conventions in `README.md`; open questions with your recommendation in the handoff.

## Tests and checks
- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm format:check` green (Node 22).
- Every exported PNG exists at its P2.3 path at 2x. Dark artboards use only dark tokens (the `find_nodes` check in `docs/design/README.md`).
- A search finds no "flocked.app" or "@jay" on `Cards and notifications`, and no "Questions" header link on `Core flow` (the reveal screens there may keep their own sample user).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- The fixes are applied, re-exported and recorded. Every admin screen has artboards at both breakpoints, exports and inventory rows marked `review`, including flags and config (`geo.stakes.age21`) and the hold release.
- The handoff is written.

## Constraints
- Colour and type values come only from `Design_Language.md`; anything else is a spec issue for Z.
- Don't edit the spec or the design language; record problems in the handoff. Don't fake owner actions: the Admin review (OA-D5) and the Core flow freeze (OA-D2) are the owner's.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W7-C.2`).

## End of session
1. Commit, then `git push -u origin w7-c-admin-design`.
2. Write `docs/sessions/W7-C.md` from plan.md 3.2. Under "Notes for D and Z", list the artboards the fixes changed (for the OA-D2 and OA-D3 reviews) and the schema gaps for W11-A. Commit and push.
3. End with your status and: "When W7-A, W7-B, W7-C and W6-F1 all report complete, start W7-D from `docs/prompts/W7-D.md`."
