# Session W6-Z: Consolidate wave 6

**Role:** consolidate. **Size:** M (about 20 spec issues across four handoffs, the audit status, the OA-D4 copy review). **Model:** Opus 5.5.

## Read first

- `plan.md` sections 2 (Protocol), 3.1 (Prompt template), 3.3 (Wave summary template), 3.4 (Z checklist), 4 (Global conventions) and 6 (Owner actions and launch gates; only OA-04, OA-09, OA-17, OA-20, OA-21, OA-22, OA-D2, OA-D3, OA-D4). Read nothing else in `plan.md` until a step needs it.
- `docs/plan/wave-6.md`: "Pinned interfaces", the "W6-Z checklist" and every "Carry-over" section.
- The four handoffs on `w6-integration`: `docs/sessions/W6-A.md`, `W6-B.md`, `W6-C.md`, `W6-D.md`. Also `docs/sessions/W5-Z.md` (the wave-5 summary).
- `docs/plan/traceability.md`: rows ID-5, SET-1b, PIPE-1, ALERT-3, AC-2, AC-4, NFR-4, NFR-6, NFR-7, NFR-8, ALERT-1.
- `docs/plan/wave-7.md`, to draft the next prompts. `docs/bundle-format.md` and `e2e/stack/README.md`.
- Spec sections only when an owner decision needs editing, loaded with `pnpm spec "<heading>"` (Node 22: `nvm use` first).

## Objective

Review wave 6 on `w6-integration`, get the owner's decisions on the open spec issues, and merge into `main`. Then:

- confirm the audit candidate is untouched, and record the audit status (OA-20);
- ask the owner to review Cards and notifications in Paper (OA-D4);
- update the plan files and write the wave summary;
- emit the wave-7 prompts and tag `wave-6`.

No features.

## Starting point

- Base: `w6-integration`, pushed. W6-D's head and its CI and Stack runs are listed in `W6-D.md`; the handoff and this prompt sit on top.
- Worktree. W6-D's worktree `../flocked-w6-d` has `w6-integration` checked out. Work there, or remove it first (`git worktree remove`, which works on a clean worktree), then:
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w6-z w6-integration
  cd ../flocked-w6-z && nvm use
  pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```
- The stack needs OrbStack running and Foundry on `PATH`. W6-D's subagents left worktrees under `.claude/worktrees/agent-*` with branches `w6-d-stack`, `w6-d-gating`, `w6-d-read` (all merged into `w6-integration`); remove them with the wave's other branches.

## Scope and file ownership

- May create or edit:
  - `Product_Spec.md`: only the sections the owner's decisions change, plus the Decision log;
  - `plan.md`: Status, 4.3, 4.6, 6, and anything a decision changes;
  - `docs/plan/*`, `docs/sessions/W6-Z.md` and `docs/prompts/W7-*.md`;
  - `packages/shared/src/api/index.ts`, only to add the bundle-object row to `ENDPOINTS` if the owner agrees (W6-D Deviations);
  - small fixes (< 50 lines, no new behaviour) anywhere needed to get green.
- Must not:
  - touch `contracts/src`, which is the audit candidate;
  - add features, or change pinned interfaces without an owner decision. Larger fixes become `W6-F{k}` (plan.md 2.6).

## Pinned interfaces

Compare `wave-6.md` "Pinned interfaces" with what was built:

- **Signer boundary (W6-B):** as pinned. `Env.SIGNER` is typed `TicketSignerRpc` and optional (no binding → 503 on `/prepare`). The API's tests bind a stand-in signer Worker (`apps/api/vitest.config.ts`).
- **Safe head (W6-A):** `closeBlockFor(client, closesAtSec)` and `safeHeadPast(client, {number, hash})` take a viem client first; `safeHeadReady(env, roundId, mode, deps?)` and `applyStakes(env, result, deps?)` gain optional deps. The manifest carries `closeBlock`.
- **W6-A, other:** `StakesEntryEvent.removed?`; SettlementDO uses phase `proposing` for Stakes until the round is final onchain; `finalize` is sent by the SettlementDO, not the indexer.
- **W6-B:** `TosState.ageRequired` is optional only because a shared fixture lacks it.
- **Read models (W6-D):**
  - `SettlementView.settledAt` is nullable (a Stakes proposal isn't finalized);
  - `ENDPOINTS`: `GET /rounds/:id`, `/verify`, `/ws` and `/rounds/:id/card/…` are `auth: 'optional'`;
  - `GET /rounds/:id/bundles/:mode/:file` is served but has no `ENDPOINTS` row yet.

## Tasks

1. **plan.md 3.4 steps 1–3:**
   - All four handoffs must be `complete`.
   - Run `git diff --stat main...w6-integration`.
   - Read full diffs only where a handoff flags risk:
     - W6-A: `src/chain/operator.ts` (the nonce allocator), `src/do/anchor-do.ts` `checkOnchain` / `expire` (S5), `src/do/settlement-do.ts` `follow` / `backstop` / `timedOut`, `src/settlement/prepare.ts` (the stream check);
     - W6-B: `src/stakes/prepare.ts` (check order, conditional insert, delete on signer failure), `src/routes/me.ts` (`POST /me/tos` writes `age_attested_min`);
     - W6-D: `src/read/{access,proofs,me}.ts`, `src/settlement/apply/free.ts` (the reveal now precedes the credits), `src/lifecycle/handlers.ts` (`used_tx`; Stakes void refunds), `e2e/stack/up.mjs` (two configs in one `wrangler dev`, the signer's env file).
   - Run:
     - `pnpm install --frozen-lockfile && pnpm check`;
     - `pnpm format:check`;
     - `(cd contracts && FOUNDRY_PROFILE=ci forge test)` (about 6 min);
     - `pnpm stack:up`, then every stack file one at a time in the CI order (`stack-smoke`, `lifecycle-open-close`, `free-settle`, `anchor-tx`, `indexer-reorg`, `stakes-ticket`, `stakes-settle`, `claims-wallet`; about 10 min; `stakes-settle` moves anvil's clock 2 h, so only `claims-wallet` follows it), then `pnpm stack:down`. Plain `pnpm --filter @flocked/e2e exec vitest run` keeps that order through `e2e/vitest.config.ts`'s sequencer.
   - Confirm that `gh run list --branch w6-integration` shows CI (four jobs) and Stack (eight test steps) green.
2. **Audit candidate and OA-20:**
   - `git diff audit-candidate-1 HEAD -- contracts/src` must be empty, on `w6-integration` and again on `main` after the merge;
   - ask the owner whether an auditor is booked and when the report is expected (needed before W15), and record the answer in `plan.md` Status and OA-20.
3. **W6-Z checklist (`wave-6.md`):** prove each row by a named, passing test, and update `docs/plan/traceability.md`:
   - **ID-5:** `apps/api/test/stakes/prepare.test.ts` (W6-B lists the branches);
   - **SET-1b (rules 5, 6):** `apps/api/test/settlement/stakes-settle.test.ts` (W6-A). With rules 4, 7, 8 proven earlier, SET-1b can close;
   - **PIPE-1 (API, bundles):** `apps/api/test/gating/reveal.test.ts` and `bundles.test.ts` (W6-D). WS (W7-A), cards (W10-A) and the log scan (W13-C) stay open;
   - **ALERT-3:** `stakes-settle.test.ts` › "streams, waits for the safe head (ALERT-3), proposes …" (detection; paging is W13-A);
   - **AC-4 (API half):** `prepare.test.ts` › "one person cannot hold tickets for one round on two wallets …";
   - **NFR-6 (Stakes):** `stakes-settle.test.ts` › "a proposal still pending is polled, never posted again, and a later apply checks the chain first";
   - **NFR-7:** `apps/api/test/stakes/isolation.test.ts`, `apps/signer/test/isolation.test.ts`, `e2e/tests/stakes-ticket.test.ts`, and the stack's `signer` status row (the deploy-config review and the multisigs stay open);
   - **ALERT-1 (Stakes reconciliation):** `stakes-settle.test.ts` (the three reconciliation tests W6-A names);
   - also AC-2 (API part; same tests as PIPE-1), NFR-4 (part; `e2e/tests/stakes-settle.test.ts`), and the claim-proof requirement (`e2e/tests/claims-wallet.test.ts`).
   - Reserve the wave-7 migrations: W7-A `0014`, W7-B `0015`, W7-D `0016`.
4. **OA-D4.** Ask the owner to review the Paper page `Cards and notifications` (92 artboards; needed before W10) together with the new copy lines in `W6-C.md` "Open issues" (push titles and bodies, email headings and CTAs, card and share lines) and its open questions (a)–(c), recommendation first. Record the answer; a freeze moves OA-D4 to done.
5. **Spec issues.** Raise them with the owner via AskUserQuestion, recommendation first, batched by area:
   - **Stakes settlement (W6-A, 5):** "the backend calls `finalize`"; `refund` payouts for every Stakes refund; the reconciliation wording (each mismatch alerts, a reconciling fallback proceeds); what a vetoed refund proposal is for; too few entrants with no reveal and no bundle.
   - **Tickets and age (W6-B, 5):** `stakes_tickets.game_day` and `users.age_attested_min` in the Data model; `ageAttested: 18 | 21`; `geo.stakes.age21` region entries vs the verified country; personTag's round ID is the ULID; the cap gap (now narrowed: W6-D sets `used_tx` at ingestion).
   - **Cards and notifications (W6-C, 5):** accent on cards; the domain; long questions and amounts; `refundReason` and share in the `outcome` payload; Free refund wording.
   - **Reads (W6-D, 6):** the re-signed Free receipt in `/me`; the bundle-object route (add the `ENDPOINTS` row, or an R2 public domain); room-round payouts left out of `?wallet=`; freezing `payoutAddress` at lock; rounds public only once locked; the Free reveal before any balance moves.
   - **Open decision (W6-D):** claimed foreign entries stay listed by `?wallet=`; recommend leaving it (signer-compromise path, held) with a W13 note, or a table in a later migration.

   Apply the decisions to the spec and the Decision log. Anything that changes code beyond a small fix goes into wave 7 (or a `W6-F{k}`). Name the changed sections in the wave-7 prompts.
6. **Plan fixes from the handoffs:**
   - §4.3: eight stack tests (`stakes-ticket`, `stakes-settle`, `claims-wallet` added; about 10 min), the vitest sequencer, `stack:status`'s `signer` row, the signer in the API's `wrangler dev`, `PERSON_TAG_KEY` in `.dev.vars`, the local `config` seeds;
   - §4.6: the Stack job's eight steps and its 30-minute timeout.

   Record the open issues as carry-over in later wave files:
   - **W7-A:** gate `/ws` with `roundAccess` (already in front of the stub) and send nothing per option before `revealed_at`; the RoundDO's Stakes status stays `settle_proposed` after `RoundFinalized` (D1 is the record);
   - **W7-B:** reuse `effectiveDailyCap` and `DEFAULT_DAILY_STAKE_CAP` in the limits route;
   - **W9-A:** Stakes notifications and cards; `refundReason` (and share) in the `outcome` payload;
   - **W10-A:** the card route is gated already; satori notes on each card artboard; fonts and inlined SVG poses;
   - **W13:** the `RoundFinalized` payouts insert at 100k; the per-isolate proof trees in `/claims` and `/me`; retention of `entered-*.json` and Stakes ciphertexts; `PERSON_TAG_KEY` (rotate only between rounds) and `TICKET_SIGNER_KEY` in the secrets runbook; `BASE_RPC_URL_FALLBACK` in staging and production;
   - **anvil clock lag after `indexer-reorg`** (W7-D's e2e harness).
7. **Merge (plan.md 3.4 step 6):**
   - `main` ← `w6-integration` with `--no-ff`, then push.
   - Delete `w6-a-stakes-settlement`, `w6-b-signer`, `w6-c-design`, `w6-d-stack`, `w6-d-gating`, `w6-d-read` and `w6-integration` (local and remote where pushed), and the `worktree-agent-*` branches.
   - Remove the worktrees `../flocked-w6-{a,b,c,d}` and `.claude/worktrees/agent-*`.
   - Tag `wave-6` on `main` only after the summary and the wave-7 prompts are committed (steps 8 and 10).
8. **Plan files:** update `plan.md` Status, `docs/plan/traceability.md`, and any later wave file whose plan changed. Write `docs/sessions/W6-Z.md` from plan.md 3.3.
9. **Owner actions:**
   - **OA-20:** the audit status (step 2). Booking is the critical path for W15.
   - **OA-D4:** Cards and notifications (step 4), needed by W10.
   - **OA-D3:** Social and Settings in Paper, needed by W11.
   - **OA-D2:** the core flow, needed by W9 (after W7-C removes the header link).
   - **OA-09:** the Coinbase OAuth app, started by W8.
   - **OA-22:** the response shape, checked in W14-A.
   - **OA-21:** legal text by W12; it also sets `geo.stakes.allow` and `geo.stakes.age21`.
   - **OA-04:** Workers Paid and the deploy token, started by W10.
   - **OA-17:** the admin and guardian multisigs, started by W10.
10. **Wave-7 prompts:** emit them from `docs/plan/wave-7.md` and plan.md 3.1, pointing at `docs/sessions/W6-Z.md`.
    - Migrations: W7-A `0014`, W7-B `0015`, W7-D `0016`.
    - Name every spec section changed this wave.
    - Stack tests can reuse `POST /__test/rounds/scheduled` (with `stakes`), `POST /__test/stakes/tickets`, the cron driver, `GET /__test/rounds/:id` and `GET /__test/bundles/...`; the real `/prepare` path runs on the stack (`e2e/tests/stakes-ticket.test.ts`).

## Tests and checks

- `pnpm install --frozen-lockfile && pnpm check` and `pnpm format:check` green on `w6-integration` before merging, and on `main` after.
- `(cd contracts && FOUNDRY_PROFILE=ci forge test)` green, and every stack test green locally.
- CI and Stack green on `w6-integration`, and on `main` after the push.
- `git diff audit-candidate-1 HEAD -- contracts/src` empty.
- No test is skipped, deleted or weakened without a line in `W6-Z.md` with the reason.

## Definition of done

- `main` contains wave 6, tagged `wave-6`, with CI and Stack green. The wave branches and worktrees are removed.
- ID-5, SET-1b (5, 6), PIPE-1 (API, bundles), ALERT-3, AC-4 (API half), NFR-6 (Stakes), NFR-7 and ALERT-1 (Stakes) are each proven by a named test, and the traceability rows are updated.
- The audit candidate is confirmed unchanged, and the audit status is recorded in Status and OA-20. The owner has been asked about OA-D4 with W6-C's copy lines.
- The owner's decisions are in the spec with Decision log rows, and the plan files are updated.
- `docs/sessions/W6-Z.md` is written, and the wave-7 prompts are saved, committed and printed.

## Constraints

- Never merge a red wave (plan.md 2.6). Fixes over ~50 lines, or with new behaviour, go to a `W6-F{k}` session, with a `W6-Z.2` prompt to run after it (or, by the Oct 12 option, Z runs the fix itself on branches off `w6-integration`).
- Never commit secrets (`e2e/stack/.dev.vars`, `.state.json` and `.run/` are gitignored). Don't fake owner actions or launch gates. Booking the auditor is the owner's.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6. Subagents may take the diff reviews and the spec edits.

## End of session

1. Commit, and push `main`.
2. Write `docs/sessions/W6-Z.md` (plan.md 3.3), then commit and push it.
3. Save every wave-7 prompt to `docs/prompts/W7-{X}.md`, then commit and push them. Then tag `wave-6` on `main` and push the tag.
4. Print each prompt in its own fenced block. Say which run in parallel, and that the owner starts each in a fresh session.
