# Wave 10: Stakes UI, share cards, watcher I

**Goal.** Players can enter Stakes and claim from the browser through a sponsored smart-wallet user operation. Every settled player gets a share card. The independent watcher verifies Stakes rounds.

**Base.** Tag `wave-9`. **Hold point:** OA-D4 (cards) before W10-A; OA-D2 already frozen. **Migrations reserved:** W10-A `0022`, W10-D `0023`; the watcher has its own D1 (`apps/watcher/migrations/0001`).

## Pinned interfaces

- **Card storage:** R2 keys `cards/{roundId}/{mode}/{userId}/{kind}/{variant}.png` and `cards/{roundId}/{mode}/round/{variant}.png`; `share_cards` rows with opaque share IDs.
- **Watcher verdicts:** `apps/watcher` publishes `{ subject, roundId, mode, verdict: 'match' | 'mismatch' | 'unable', reasons[], checkedAt, signature }`. The signature is EIP-191, by `WATCHER_KEY`. It's served at `/verdicts/:subject/:id` and also posted to the paging webhook on mismatch or unable. The verdict schema lives in `apps/watcher/src/verdict.ts` and is copied into `packages/shared/src/watcher.ts` by D.
- **Paymaster proxy:** `POST /api/v1/paymaster` (ERC-7677 `pm_getPaymasterStubData` / `pm_getPaymasterData`), owned by W10-D.

## W10-A: Share cards

- **Role / size:** build, M.
- **Objective.** Build the `cards` queue consumer: satori + resvg-wasm rendering of the result, teaser and round cards in three variants, matching the Paper card artboards. Amounts are shown only if the user opted in (otherwise the multiple). Stray streak ≥ 2. Handle, avatar, wordmark and URL. Render at reveal fan-out with a 5-minute target; render on demand if missing. Also:
  - `GET /s/:shareId` (OG and Farcaster mini app embed meta, "Play today's Flocked" button; the teaser links to the round after the reveal);
  - `GET /cards/:shareId/:variant.png` and `GET /rounds/:id/card/:variant.png` (404 until the mode reveals);
  - veto → re-render at the same keys plus an edge cache purge;
  - deletion → re-render without handle or avatar;
  - `share_landing` analytics and `ref` attribution.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W9-Z.md`. This section. `docs/design/screens.md` (cards rows), the card exports, those Paper artboards. Spec: "Share cards and distribution" (only "Card content", "Generation", "Share surfaces").
- **Owns.** `apps/api/src/cards/**`, `apps/api/src/routes/cards.ts`, migration `0022`, `apps/api/test/cards/**`, `apps/api/assets/fonts/**`.
- **Required tests.** PIPE-1 (cards half: no card or split before the reveal). AC-7 (cards exist for every settled player). Pixel comparison of rendered cards against the exports. Legibility at 25% (render, downscale, and compare the result-line region against a threshold; document the method).

## W10-B: Watcher I (Stakes)

- **Role / size:** build, M.
- **Objective.** Build `apps/watcher`, a Worker in its own wrangler project for a separate account, with its own D1, RPC and drand access, no shared bindings, and no shared code except published packages (`@flocked/verify`, `@flocked/settle`, `@flocked/tlock`, `@flocked/abi`). Stakes checks:
  - `RoundCreated` against the config published at lock (snapshotted independently at lock time) and the backend-independent rules (house question creator = treasury, else creator attestations, defaults unless an override was published before lock);
  - proposals by full recompute through `@flocked/verify`, including payout leaves vs derived amounts and VOID recomputation;
  - void and `refundTooFew`.

  Signed verdicts; paging on mismatch, unable, or a missing verdict 30 minutes after a proposal.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W9-Z.md`. This section. `packages/verify/README.md`. Spec: "Smart contract" (only "Challenge window, watcher and guardian").
- **Owns.** `apps/watcher/**`.
- **Required tests.** PIPE-5 (Stakes: match and mismatch, using tampered fixtures and an anvil round with a wrong proposal). AC-4 (VOID recompute part). ALERT-7 detection (mismatch).

## W10-C: Web Stakes entry + Claims

- **Role / size:** build (UI), M.
- **Objective.**
  - Stakes UI on Today: shown only if `/me` says eligible (AC-8); fixed stake; the non-default config warning; the 30-day net.
  - "Verify with Coinbase": an external browser in the mini app, then poll `/me`.
  - The round config check: every onchain `RoundConfig` field vs the published config and the launch defaults, via a public Base RPC; refuse on a mismatch.
  - Encrypt, `/prepare`, then build one sponsored user operation (approve or permit + `enter`) with wagmi/viem and the Coinbase Smart Wallet; pending until included; errors.
  - Reveal for Stakes ("Final at", provisional refund, veto → refunded).
  - The Claims page with "Claim all" in one batched user operation, claim-open times, and wallet-only claims without an account.
- **Read first.** `plan.md` §2. `docs/sessions/W9-Z.md`. This section. `docs/design/screens.md` (core: Stakes and Claims rows), the exports, and those Paper artboards. Spec: "Client app" (Claims row; "Entry flow (Stakes)"), "Sealed picks (timelock encryption)" (only "Round config check (Stakes)"), "Smart contract" (only "Gas and UX").
- **Owns.** `apps/web/src/features/{stakes,claims}/**`, `apps/web/src/wallet/**`, `e2e/ui/{stakes-eligibility,claims}.spec.ts`.
- **Required tests.** AC-8 (UI absent for each ineligibility reason). Config-mismatch refusal. Screenshot comparisons. axe.

## W10-D: Paymaster proxy + Stakes UI e2e

- **Role / size:** integrate, M.
- **Objective.** Merge A, B and C. Build the paymaster proxy:
  - sponsor only `enter`/`enterWithPermit` with a valid ticket, plus a USDC `approve(FlockedEscrow, stake)` only as the call immediately before `enter` in the same user operation;
  - `claim`, `claimRefund`, `finalize` and `withdraw`;
  - 10 sponsored user operations per user per day;
  - forward to the provider (a local bundler/paymaster mock on the stack).

  Then Stakes UI e2e: verify personhood (mock Coinbase), enter Stakes (E2E-1 Stakes UI), claim after the challenge window in the UI (E2E-4 UI), a settlement veto turning into refunds in the UI (E2E-5), and the paymaster accept/reject/cap rules (E2E-11).
- **Read first.** `plan.md` §2, §3.4. Handoffs W10-A, B, C. Spec: "Smart contract" (only "Gas and UX").
- **Owns.** Registry files; `apps/api/src/paymaster/**`; `apps/api/src/routes/paymaster.ts`; migration `0023`; `e2e/mocks/bundler/**`; `e2e/ui/{stakes-round,stakes-veto}.spec.ts`; `e2e/tests/paymaster.spec.ts`; `packages/shared/src/watcher.ts`.
- **Required tests.** E2E-1 (Stakes UI), E2E-4 (UI), E2E-5, E2E-11, AC-5 (UI parts).
- **Emits.** W10-Z prompt.

## W10-Z checklist

- AC-7 (cards), AC-8, PIPE-5 (Stakes), E2E-5, E2E-11 proven.
- Confirm OA-D3 is frozen before W11-C.
- Migrations for wave 11: W11-A `0024`, W11-B `watcher/0002`, W11-D `0025`.
