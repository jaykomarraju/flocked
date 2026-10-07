# Wave 5: Settlement

**Goal.** Free rounds settle end to end on the local stack: beacon verified, ciphertexts decrypted in a queue fan-out, tallied by `@flocked/settle`, a deterministic bundle in R2, the ledger applied, and the manifest anchored. Coinbase personhood and geo eligibility exist. Social and settings surfaces are designed.

**Base.** Tag `wave-4`. **Migrations reserved:** W5-A `0008`, W5-B `0009`, W5-D `0010`.

## Pinned interfaces

- **Settlement output (W5-A → W5-D, W6-A, W9-B):** `apps/api/src/settlement/types.ts` (W5-A) exports `TallyResult = { record: SettlementRecord; payouts: Payout[]; entries: ClassifiedEntry[]; manifest: Manifest; manifestBytes: Uint8Array; bundleHash: Hex; chunks: ChunkRef[] }`. W5-A also pins the bundle format in `docs/bundle-format.md`: manifest fields per spec "Settlement output", chunk schema, R2 keys `bundles/{roundId}/{mode}/manifest.json` and `bundles/{roundId}/{mode}/chunk-{nnnn}.json`, canonical JSON (RFC 8785), and formula version. `@flocked/verify` (W9-B) and the watcher read this document.
- **Mode-specific apply hook:** `SettlementDO` calls `applyFree(result)` or `applyStakes(result)` from `apps/api/src/settlement/apply/{free,stakes}.ts`. W5-A ships both as stubs that throw `not_implemented`. W5-D implements free, and W6-A implements stakes.
- **Personhood (W5-B):** `apps/api/src/personhood/eligibility.ts` exports `stakesEligibility(env, user, request) → { eligible: boolean; reasons: IneligibleReason[] }`. Its reasons enum is added to `packages/shared/src/api/me.ts` by B; B owns that one file this wave.

## W5-A: Settlement core

- **Role / size:** build, M.
- **Objective.** At beacon time, the settle queue consumer starts `SettlementDO(roundId, mode)`. It fetches the beacon from relays and verifies it against the pinned public key (retry every 3 s for 10 min, then alert and retry every 60 s), and for Stakes waits for a safe-head flag (a W6-A input; stub true for Free). It writes ~500-ciphertext chunks to R2 and fans out to `decrypt-daily`/`decrypt-rooms`. Decrypt consumers run `classify` and write chunk results. When every chunk is done, the reduce step runs `settle`, builds the payout tree, writes a deterministic manifest and chunks (write-once), and calls the apply hook. Anomalous VOID rate → hold and alert.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W4-Z.md`. This section. Spec: "Settlement and payout math" (only "Settlement output"), "Sealed picks (timelock encryption)" (only "Scheme" bullets on signature verification, "Invalid entries"), "Architecture" (rows SettlementDO, Settlement coordinator, Decrypt workers), "Non-functional requirements" (only "Scaling notes").
- **Owns.** `apps/api/src/settlement/**` (except `apply/free.ts` body and `apply/stakes.ts` body), `apps/api/src/do/settlement-do.ts`, `apps/api/src/queues/{settle,decrypt}.ts`, `docs/bundle-format.md`, migration `0008`, `apps/api/test/settlement/**`.
- **Required tests.** PIPE-4 (two runs byte-identical, including after a simulated retry with a different relay). SET-4 (pipeline half: each VOID kind from real ciphertexts). Idempotency: re-delivered chunk messages don't double-count (NFR-6 part). ALERT-1, ALERT-5. Bundle objects are write-once.
- **Risks.** Queue consumer `cpu_ms` limits in tests; chunk ordering determinism.

## W5-B: Personhood

- **Role / size:** build, M.
- **Objective.** Build Coinbase sign-in: `POST /me/personhood` (authorize URL, PKCE where supported, single-use state bound in AuthDO), and `GET /me/personhood/callback` (attributes only to the state's user). It reads `/v2/user` and `/v2/user/personal-details`, stores `person_id` = HMAC, the country and region only, and sets `kyc_status`. If the person ID is already bound to another account, the callback creates a pending merge. Also: the Verified Account and Verified Country attestation lookup (EAS indexer client), geo rules (`geo.stakes.allow`, `request.cf`, proxy signals), the person tombstone check on verification, and Stakes eligibility in `GET /me`. A Coinbase mock server goes in `e2e/mocks/coinbase/` and an EAS indexer mock in `e2e/mocks/eas/`.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W4-Z.md`. This section. Spec: "Identity and personhood" (only "Personhood (verified Coinbase sign-in)", and "Account deletion" tombstone bullet), "Compliance and responsible play" (only "Geo-fencing", "Age and terms").
- **Owns.** `apps/api/src/personhood/**`, `apps/api/src/routes/personhood.ts` (D mounts it), `packages/shared/src/api/me.ts`, migration `0009`, `apps/api/test/personhood/**`, `e2e/mocks/{coinbase,eas}/**`.
- **Required tests.** ID-2, ID-3 (login CSRF: a callback with another user's cookie attributes to the state's user only; a replayed state fails). No raw Coinbase ID, name or address stored (NFR-8 part, asserted by a DB scan). Country mismatch → ineligible. Missing personal details → not verified.
- **Risks.** Coinbase API shape uncertainty (gate 2). Build to the documented shape, keep the mock faithful to it, and note anything unverifiable.

## W5-C (design): profiles, boards, rooms, settings, verify

- **Role / size:** design, M (split `.2` if needed: settings + claims/verify in `.2`).
- **Objective.** Design every screen and state for Round detail, Archive, Verify (including "Verify my entry" steps and failure states), Profile (own and other; private Stakes net), Leaderboards (4 tabs, mode filter, empty), Submit (live validation, moderation results, blocked-for-7-days), Queue (voting, empty), Rooms (list, create, invite, room round, member picks after reveal, room board), and Settings (identities, pending merges, Coinbase verification, payout wallet, card and profile privacy, notifications, stake cap with the 24 h pending increase, self-exclusion flows including permanent and lift request, delete account with unclaimed payouts and "Claim all", sign out, responsible gambling link).
- **Read first.** `plan.md` §5.4. `docs/design/README.md`, `docs/design/screens.md`. `Design_Language.md`. Spec: "Client app" (table), "Profiles, leaderboards and rooms", "Identity and personhood" (only "Identities", "Merging accounts"), "Compliance and responsible play" (only "Responsible play"), "Question pipeline" (steps 1–3). Schemas: `packages/shared/src/api/{boards,users,rooms,questions,me,limits}.ts`.
- **First step.** Confirm the Paper MCP tools; if missing, stop as `blocked`.
- **Owns.** Paper page `Social`; `docs/design/screens.md` (social and settings sections); `docs/design/exports/social/**`, `docs/design/exports/settings/**`.

## W5-D: Free settlement apply

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C, then build `applyFree`:
  - write the settlement record, payouts and ledger movements in idempotent chunked jobs (the ledger's unique key prevents double credit);
  - creator award, and burned dust recorded;
  - entries' `option_index`, `valid` and `void_reason`;
  - `revealed` set when the outputs are durable, notifying RoundDO (`onModeResult`), which keeps its broadcast hook a no-op until W7;
  - refund rules 1–3, 7 (commitment not anchored before the beacon) and 8 (beacon unavailable at +24 h, conditional update);
  - the manifest anchor through AnchorDO (`anchorManifest`);
  - ciphertext archival after durability;
  - the nightly `point_balances` vs `points_ledger` reconciliation job.
- **Read first.** `plan.md` §2, §3.4. Handoffs W5-A, B, C. `docs/bundle-format.md`. Spec: "Round lifecycle" (Free rows), "Settlement and payout math" (only "Refund rules", and the Free bullets of "Normal case"), "Data model" (rows `settlements`, `payouts`; "Archival"; "Atomic points movements").
- **Owns.** Registry files; `apps/api/src/settlement/apply/free.ts`; `apps/api/src/jobs/reconcile.ts`; migration `0010`; `apps/api/test/settlement/free-*.test.ts`; `e2e/tests/free-settle.test.ts`.
- **Required tests.** SET-1b (rules 7, 8). NFR-6 (re-running apply yields identical rows and no double ledger rows). A local-stack test: a Free round with ~50 entries from multiple users settles, the bundle is anchored, and balances match.
- **Emits.** W5-Z prompt.

## W5-Z checklist

- PIPE-4, ID-2, ID-3, SET-1b (7, 8), SET-4 (pipeline), ALERT-1/5 detection proven.
- Ask the owner to review Social and Settings in Paper (OA-D3 before W11).
- Migrations for wave 6: W6-A `0011`, W6-B `0012`, W6-D `0013`.
- Check the audit status (OA-20) and log the expected report date in Status.
