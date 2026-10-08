# Session W3-B: RoundDO Free entries

**Role:** build. **Size:** M (split into `W3-B.2` if needed: the tlock fix, init, the commit protocol and receipts first; the alarm chain, close and the commitment root second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-3.md`: the intro, "Pinned interfaces", "W3-B" and "Changes from W2-Z".
- `docs/sessions/W2-Z.md` (wave-2 summary). Then `docs/plan/wave-2.md` "P2.1" and "P2.4" with the "As built (W2-Z)" note, and `packages/tlock/README.md` ("VOID order").
- Code you build on: `apps/api/src/do/{types,round-do,stub}.ts`, `apps/api/src/points/index.ts` (`stakeMovement`, `grantMovement`), `apps/api/src/lib/**`, `apps/api/test/helpers/`, `packages/shared/src/{config,eip712,ids,time,queues}.ts`, `packages/shared/src/api/entries.ts`, `packages/tlock/src/{header,seal,classify}.ts`, `packages/settle` (`freeCommitmentTree`, `userIdHash`), `packages/abi/src/FlockedAnchor.ts`, `packages/abi/scripts/receipt-fixture.mjs`.
- Spec sections (Node 22: `nvm use` first), only the parts named:
  ```bash
  pnpm spec "Real-time and the reveal" --sub "RoundDO responsibilities"
  pnpm spec "Sealed picks (timelock encryption)" --sub "Free mode specifics"
  pnpm spec "Sealed picks (timelock encryption)" --sub "Invalid entries"
  pnpm spec "Sealed picks (timelock encryption)" --sub "Canonical ciphertext header"
  pnpm spec "Data model"                 # rows entries, round_modes, limits; "Atomic points movements"
  pnpm spec "Modes: Free and Stakes"     # the table only
  pnpm spec "Compliance and responsible play" --sub "Responsible play"
  ```
  Changed in wave 2 (Decision log, Oct 8, 2026): "Sealed picks" (VOID order, canonical header and `U` rules, receipt domain version "1", `freeConfigHash`), "Modes: Free and Stakes" (presets, `capMultiple`, the daily-grant skip), "Data model" (foreign entries, time units). Read the Oct 8 Decision log rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 8'`.

## Objective
RoundDO accepts sealed Free entries and returns signed receipts. First fix the tlock gap the W2-Z review found: a ciphertext whose `U` has a coordinate ≥ the field modulus classifies as valid today. Then build RoundDO's Free path: init from the locked config, the commit protocol (validation, dedupe, `seq` reservation, the atomic points batch, the leaf, the EIP-712 receipt), counters, the alarm chain (open; `closing_soon`/`streak_at_risk` hooks that only enqueue; close; the settle enqueue at beacon time; the rule-8 alarm), close (drain in-flight entries, reconcile leaves against D1, build the commitment root with `freeCommitmentTree`), `POST /rounds/:id/entries`, and the daily grant on first entry.

## Starting point
- Base: tag `wave-2`. Branch: `w3-b-round-do`. Worktree: `../flocked-w3-b`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w3-b -b w3-b-round-do wave-2
  cd ../flocked-w3-b && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit: `apps/api/src/do/round-do.ts`, `apps/api/src/rounds/**`, `apps/api/src/crypto/receipt.ts`, `apps/api/src/routes/entries.ts`, `apps/api/migrations/0003_round_do.sql`, `apps/api/test/round-do/**`; for the tlock fix `packages/tlock/src/{seal,classify}.ts`, `packages/tlock/test/**`, `packages/tlock/README.md`; for the receipt fixture `packages/abi/scripts/receipt-fixture.mjs`, `packages/abi/test/**`; `docs/sessions/W3-B.md`.
- Must not touch: WebSocket handling (W7-A owns `src/ws/**`; leave a `broadcast()` no-op hook), Stakes ingest beyond the RPC stub, `apps/api/src/{app,env,index}.ts`, `apps/api/src/routes/index.ts`, `apps/api/wrangler.jsonc`, `apps/api/src/points/**` and `packages/shared/**` (pinned; record needed changes for D), other route modules and DOs, `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P2.4 `RoundDO`: `init(locked)`, `enterFree(req)`, `getState()`, `ingestStakesEntry(evt)`, `onModeResult(mode, result)`, `requestVoid()` (`apps/api/src/do/types.ts`; `EnterFreeRequest`/`EnterFreeResponse`). The entries rows of `ENDPOINTS`.
- P2.1 tlock: `isCanonicalHeader`, `classify` (never throws for bad ciphertext; throws for a bad signature or a non-16-byte `roundRef`). The receipt domain `("Flocked", "1")` and typehash from P2.2, built with `@flocked/shared`'s `eip712.ts`; `roundKey` mode codes Free = 0, Stakes = 1.
- `RECEIPT_SIGNER_KEY` (already in `Env`; tests generate one).

## Tasks
1. Create the worktree (above).
2. tlock fix, as its own green commit: `classify` returns `decrypt_failed` when `U` isn't a canonical compressed G2 point (re-encode and compare) or the stanza body has the wrong length; environment errors (`TypeError`, `ReferenceError`) are rethrown instead of becoming VOIDs (or add a startup self-test that decrypts the committed fixture). Add TL-3 cases for both; update the README's VOID order.
3. Receipts: `src/crypto/receipt.ts` signs with the shared builder; switch `receipt-fixture.mjs` to settle's `userIdHash` (bytes16 + binary ULID) and regenerate its fixture; prove a receipt verifies against `verifyReceipt` semantics and the signer address.
4. RoundDO Free path per the Objective. Validation at submit: canonical header, target round, stake within the locked range, ciphertext ≤ 2,048 bytes, room membership against `room_members`, limits. On any batch failure, look up the existing entry before answering (a retried stake that already committed fails the balance CHECK first). Document how `seq` avoids gaps.
5. Alarm chain and close; the commitment root; `POST /rounds/:id/entries` with `requireUser` and `validate()`.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22); `pnpm --filter @flocked/tlock test` covers the new TL-3 cases.
- Required: DO-1..4 and DO-5 (alarm-chain half); a close-boundary race with concurrent entries at `closesAt` (DO-3); receipt verification against the root and the signer address; an insufficient balance leaves no entry, ledger row or `seq` gap; room membership. Name each test in the handoff with its traceability ID.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- Every acknowledged entry is in the root; a non-canonical header and an out-of-range stake are rejected at submit; the `U` case is VOID; DO-1..4 and DO-5 (alarms) have named, passing tests; the handoff is written.

## Constraints
- Never commit secrets; tests generate keys. Never log `optionIndex`, plaintext or nonce (the logger redacts them; don't route around it).
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, follow plan.md 2.6 (`W3-B.2`).

## End of session
1. Commit, then `git push -u origin w3-b-round-do`.
2. Write `docs/sessions/W3-B.md` from plan.md 3.2 (env, binding and `src/index.ts` changes for D under "Notes for D and Z"). Commit and push.
3. End with your status and: "When W3-A, B and C all report complete, start W3-D from `docs/prompts/W3-D.md`."
