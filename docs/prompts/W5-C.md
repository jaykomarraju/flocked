# Session W5-C (design): profiles, boards, rooms, settings, verify

**Role:** design. **Size:** M (split into `W5-C.2` if needed: the two Components fixes, Round detail, Archive, Profile, Leaderboards, Submit, Queue and Rooms first; Settings, Claims and Verify second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template), 4 (Global conventions) and 5.4 (Design track and freezes). Read nothing else in `plan.md`.
- `docs/plan/wave-5.md`: the intro, "W5-C", and the W5-C items of "Carry-over from W3-Z".
- `docs/sessions/W4-Z.md` (wave-4 summary).
- Design files:
  - `docs/design/README.md`: pages, artboard names, exports, the contrast rules, the component and screen conventions, "Paper MCP notes";
  - `docs/design/screens.md`: the Foundations, Components and Core flow inventories and decisions;
  - `Design_Language.md` (whole; short).
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "Client app"                                  # the table
  pnpm spec "Profiles, leaderboards and rooms"
  pnpm spec "Identity and personhood" --sub "Identities"
  pnpm spec "Identity and personhood" --sub "Merging accounts"
  pnpm spec "Compliance and responsible play" --sub "Responsible play"
  pnpm spec "Question pipeline"                           # steps 1–3 only
  ```
  Wave 4 changed nothing you draw (Decision log, Oct 11, 2026: scheduling, alerts, indexer tables, contract risks, voids). A void before close still shows as the rule-4 refund line from the core flow.
- Schemas, for the data each screen shows: `packages/shared/src/api/{boards,users,rooms,questions,me,limits}.ts`.

## Objective
Design every screen and state, in Paper at mobile, tablet and desktop, for these surfaces:
- **Round detail** and **Archive**.
- **Verify:** the "Verify my entry" steps and their failure states.
- **Profile:** your own and another player's, with the Stakes net kept private.
- **Leaderboards:** four tabs, the mode filter, and the empty state.
- **Submit:** live validation, moderation results, and blocked-for-7-days.
- **Queue:** voting, and the empty state.
- **Rooms:** the list, create, invite, a room round, member picks after the reveal, and the room board.
- **Settings:**
  - identities and pending merges;
  - Coinbase verification and the payout wallet;
  - card and profile privacy, and notifications;
  - the stake cap, with the 24 h pending increase;
  - self-exclusion, including permanent exclusion and the lift request;
  - account deletion, with unclaimed payouts and "Claim all";
  - sign out, and the responsible-gambling link.

Before your own pages, apply the two Components fixes the owner decided on Oct 9 (`wave-5.md` "Carry-over from W3-Z").

## Starting point
- Base: tag `wave-4`. Branch: `w5-c-design`. Worktree: `../flocked-w5-c`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w5-c -b w5-c-design wave-4
  cd ../flocked-w5-c && nvm use && pnpm install --frozen-lockfile
  ```
- First step: confirm the Paper MCP tools are visible and the file "Flocked" opens (`https://app.paper.design/file/01M4C8WJPZXED0ZQH8RZTPN57G`). If they're missing, stop as `blocked`.

## Scope and file ownership
- May create or edit:
  - Paper page `Social` (new), and on the `Components` page only the two carry-over fixes;
  - `docs/design/screens.md`: the social and settings sections, and the two Components rows the fixes touch;
  - `docs/design/exports/{social,settings}/**`, and the two re-exported sheets under `docs/design/exports/components/**`;
  - `docs/design/README.md`, only if a new convention is needed;
  - `docs/sessions/W5-C.md`.
- Must not touch: application code, `packages/**` (including `design-tokens.json`), the `Foundations` and `Core flow` pages, `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- P2.3 (`docs/plan/wave-2.md`):
  - the Paper page names;
  - artboard names `<surface>/<screen>/<state>/<breakpoint>`;
  - exports at `docs/design/exports/<surface>/<screen>__<state>__<breakpoint>.png` (2x);
  - inventory rows in `screens.md`.
- The tokens are frozen (OA-D1). Use only existing tokens and components; a missing one is a spec issue for Z.

## Tasks
1. Create the worktree, and confirm Paper (above).
2. The Components fixes:
   - update the navigation-sheet note: the 30-day net replaced "balance hidden in Stakes";
   - add the countdown exception to the round-status sheet: hh:mm:ss everywhere, except the unsealing countdown, which is m:ss.

   Re-export both sheets.
3. Every state listed in the Objective at `mobile`, `tablet` and `desktop`, named per P2.3, exported, with an inventory row marked `review`. On tablet and desktop, Submit, Queue, Claims and Settings sit in the header avatar menu (Oct 9 decision).
4. Copy: use the Voice lines as written. List any new lines you draft in the handoff, for W5-Z to bring to the owner.
5. Open questions: record each with your recommendation in the handoff.

## Tests and checks
- `pnpm lint`, `pnpm test` and `pnpm format:check` green (Node 22).
- Every exported PNG exists at its P2.3 path at 2x. Dark artboards use only dark tokens (the `find_nodes` check in `docs/design/README.md`).
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Every listed state has artboards at all three breakpoints, exports and inventory rows marked `review`. The two Components fixes are applied and re-exported. The handoff is written.

## Constraints
- Colour and type values come only from `Design_Language.md`; anything else is a spec issue for Z.
- Don't edit the spec or the design language; record problems in the handoff. Don't fake owner actions: the freeze (OA-D3) is the owner's.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W5-C.2`).

## End of session
1. Commit, then `git push -u origin w5-c-design`.
2. Write `docs/sessions/W5-C.md` from plan.md 3.2. Commit and push.
3. End with your status and: "When W5-A, B, C and W4-F1 all report complete, start W5-D from `docs/prompts/W5-D.md`."
