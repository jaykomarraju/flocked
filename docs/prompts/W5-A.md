# Session W5-A: Settlement core

**Role:** build. **Size:** M (split into `W5-A.2` if needed: beacon fetch and verify, chunking and the decrypt fan-out first; reduce, the bundle and the apply hook second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-5.md`: the intro, "Pinned interfaces", "W5-A", and the W5-A and "All" items of every "Carry-over" section (W2-Z, W3-Z, W4-Z).
- `docs/sessions/W4-Z.md` (wave-4 summary). Then `e2e/stack/README.md` (the stack, the cron driver and the `/__test/*` seam).
- Code you build on:
  - `apps/api/src/do/{types,settlement-do,stub}.ts` (P2.4 `SettlementDO` signatures; the stub you replace);
  - `apps/api/src/do/round-do.ts`, read only: its `settle` event sends the `settle` message at beacon time;
  - `apps/api/src/queues/index.ts`: the `HANDLERS` table, where you edit only the `settle` and decrypt entries;
  - `packages/shared/src` queue message schemas (`QueueMessageSchemas`);
  - `apps/api/wrangler.jsonc`, read only: queue consumer settings and the R2 binding;
  - `packages/settle` (`settle`, the payout tree, `freeCommitmentTree`);
  - `packages/tlock` (`classify`, beacon signature verification, `chains.ts`);
  - `apps/api/src/indexer/holds.ts` (`settlementHold`).
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "Settlement and payout math" --sub "Settlement output"
  pnpm spec "Sealed picks (timelock encryption)"      # only the "Scheme" bullets on signature verification, and "Invalid entries"
  pnpm spec "Architecture"                            # rows SettlementDO, Settlement coordinator, Decrypt workers
  pnpm spec "Non-functional requirements" --sub "Scaling notes"
  ```
  Changed in wave 4 (Decision log, Oct 11, 2026): "Settlement and payout math" (rule 4's Free refunds are written at void confirmation, not by settlement), "Identity and personhood" (a settlement hold is released only by the guardian's admin action), "Non-functional requirements" (ALERT-6, ALERT-8), "Data model" (`settlement_holds` and the indexer tables). Read the Oct 11 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 11'`.

## Objective
Build the settlement pipeline up to the apply hook:
- At beacon time, the `settle` queue consumer starts `SettlementDO(roundId, mode)`.
- The DO fetches the beacon from the relays and verifies it against the pinned public key. It retries every 3 s for 10 min, then alerts and retries every 60 s.
- For Stakes, it waits for a safe-head flag, a W6-A input; stub it true for Free.
- It writes chunks of about 500 ciphertexts to R2 and fans them out to `decrypt-daily` / `decrypt-rooms`.
- Decrypt consumers run `classify` and write each chunk's result.
- When every chunk is done, the reduce step:
  - runs `settle`;
  - builds the payout tree;
  - writes a deterministic manifest and its chunks, write-once;
  - calls the apply hook (`applyFree` / `applyStakes`, which you ship as `not_implemented` stubs).
- An anomalous VOID rate holds the settlement and alerts.

Pin the bundle format in `docs/bundle-format.md`.

## Starting point
- Base: tag `wave-4`. Branch: `w5-a-settlement`. Worktree: `../flocked-w5-a`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w5-a -b w5-a-settlement wave-4
  cd ../flocked-w5-a && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/settlement/**`, except the bodies of `apply/free.ts` (W5-D) and `apply/stakes.ts` (W6-A), which you ship as stubs;
  - `apps/api/src/do/settlement-do.ts`, `apps/api/src/queues/{settle,decrypt}.ts`, and the `settle`, `decrypt-daily` and `decrypt-rooms` entries of `HANDLERS` in `apps/api/src/queues/index.ts`;
  - `docs/bundle-format.md`, migration `apps/api/migrations/0008_*.sql`, `apps/api/test/settlement/**`, and `apps/api/test/migrations.test.ts` for your tables;
  - stack tests in `e2e/tests/settle-*.test.ts` if you add any;
  - `docs/sessions/W5-A.md`.
- Must not touch:
  - W4-F1's paths, which run alongside you: `apps/api/src/{chain,scheduler,indexer,lifecycle}/**`, `do/{anchor-do,indexer-do,round-do}.ts`;
  - W5-B's `apps/api/src/personhood/**`, `routes/me.ts` and `packages/shared/src/api/me.ts`;
  - the registry files: `apps/api/src/{app,env,index}.ts`, `routes/index.ts`, `wrangler.jsonc`, `.github/workflows/*`, root and `e2e/` `package.json`. Put needed bindings in "Notes for D";
  - `contracts/**`, `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- `wave-5.md` "Pinned interfaces":
  - `TallyResult` in `apps/api/src/settlement/types.ts`;
  - the bundle format in `docs/bundle-format.md`: manifest fields, chunk schema, the R2 keys `bundles/{roundId}/{mode}/manifest.json` and `chunk-{nnnn}.json`, RFC 8785 canonical JSON, the formula version;
  - the apply hooks `apply/{free,stakes}.ts`.
- P2.4 `SettlementDO` signatures (`apps/api/src/do/types.ts`). The queue message schemas in `packages/shared` stay as pinned; a change needs a note for Z.

## Tasks
1. Create the worktree (above).
2. Beacon fetch from the relays, with verification against the pinned key (`@flocked/tlock`). Retry and alert per the Objective, through `ALERT_BEACON_LATE` / `ALERT_SETTLEMENT_FAILED` from `packages/shared/src/alerts.ts`.
3. Chunking, the decrypt fan-out and the chunk results. Chunk boundaries and the order within a chunk are deterministic, by `seq`. Decrypt costs about 6.4 ms per entry in workerd, so batch within the Worker's `cpu_ms` of 60,000.
4. Reduce: `settle`, the payout tree, and the write-once manifest and chunks in R2. Payouts are written only at finalize (W2-Z carry-over).
5. VOID rate: `ALERT_VOID_RATE` when a mode's VOIDs exceed 2 % of its entries and number at least 10, and the settlement holds.
6. Stakes only: refuse to call the apply hook while `settlementHold(db, roundId, 'stakes')` is open (W4-Z carry-over).
7. `docs/bundle-format.md`.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required:
  - PIPE-4: two runs are byte-identical, including after a simulated retry from a different relay;
  - SET-4 (pipeline half): each VOID kind from real ciphertexts;
  - idempotency: re-delivered chunk messages don't double-count (part of NFR-6);
  - ALERT-1 and ALERT-5 detection;
  - bundle objects are write-once.
- If you add a stack test, run it with `pnpm stack:up` and `pnpm --filter @flocked/e2e exec vitest run tests/settle-<name>.test.ts`, then `pnpm stack:down`. `POST /__test/rounds/scheduled` and the cron driver bring a round to beacon time with no manual call.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- A Free round's settle message produces a deterministic bundle in R2 and calls the `applyFree` stub with a `TallyResult`.
- The listed tests pass, and PIPE-4, SET-4 (pipeline), ALERT-1 and ALERT-5 are named with their tests in the handoff. `docs/bundle-format.md` exists. The handoff is written.

## Constraints
- Never commit secrets; tests generate keys.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W5-A.2`).

## End of session
1. Commit, then `git push -u origin w5-a-settlement`.
2. Write `docs/sessions/W5-A.md` from plan.md 3.2. Put bindings, env vars and any stack tests for D under "Notes for D and Z". Commit and push.
3. End with your status and: "When W5-A, B, C and W4-F1 all report complete, start W5-D from `docs/prompts/W5-D.md`."
