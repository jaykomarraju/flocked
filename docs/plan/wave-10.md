# Wave 10: Stakes UI, share cards, watcher I

**Goal.** Players can enter Stakes and claim from the browser through a sponsored smart-wallet user operation. Every settled player gets a share card. The independent watcher verifies Stakes rounds.

**Base.** Tag `wave-9`. **Hold point:** OA-D4 (cards) before W10-A; OA-D2 already frozen. **Migrations reserved:** W10-A `0023`, W10-D `0024` (shifted by W7-Z, Oct 12: W7-F1 took `0020`); the watcher has its own D1 (`apps/watcher/migrations/0001`).

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
- **Owns.** `apps/api/src/cards/**`, `apps/api/src/routes/cards.ts`, migration `0023`, `apps/api/test/cards/**`, `apps/api/assets/fonts/**`.
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
- **Owns.** Registry files; `apps/api/src/paymaster/**`; `apps/api/src/routes/paymaster.ts`; migration `0024`; `e2e/mocks/bundler/**`; `e2e/ui/{stakes-round,stakes-veto}.spec.ts`; `e2e/tests/paymaster.spec.ts`; `packages/shared/src/watcher.ts`.
- **Required tests.** E2E-1 (Stakes UI), E2E-4 (UI), E2E-5, E2E-11, AC-5 (UI parts).
- **Emits.** W10-Z prompt.

## W10-Z checklist

- AC-7 (cards), AC-8, PIPE-5 (Stakes), E2E-5, E2E-11 proven.
- Confirm OA-D3 is frozen before W11-C, and OA-D5 (Admin) before W11-A (moved up from W12 on Oct 12).
- Migrations for wave 11: W11-A `0025`, W11-B `watcher/0002`, W11-D `0026`.

## Carry-over from W2-Z (Oct 8, 2026)

- **W10-A:** share pages `/s/:shareId` and card images are served at the site root (Decision log, Oct 8), but `apps/api/wrangler.jsonc` `run_worker_first` covers only `/api/*`. Add the share and card paths (W10-A notes it for W10-D, which owns `wrangler.jsonc`).

## Carry-over from W6-Z (Oct 12, 2026)

- **W10-A:**
  - `/rounds/:id/card/*` already sits behind `requireRoundAccess` (`routes/rounds.ts`, W6-D); keep it;
  - Cards and notifications is frozen (OA-D4, Oct 12). Each card artboard's notes band names its satori primitives (flexbox, no grid). Inline each sheep pose and the flock as one SVG (they contain inner `transform`s); fonts as TTF (Fredoka 600/700, Inter 500/600/700); the square flock is small;
  - long questions and amounts: step the question and result lines down 4 px until they fit (floors 32 px and 56 px; owner decision, Oct 12). `og`/`embed` fit about 75 question characters on 2 lines; prompts go to 120;
  - the accent may mark the streak pill and the smug sheep's glint, as well as the winning bar and UNFLOCKED (Design_Language "Share cards", Oct 12); the wordmark URL is `flocked.xyz`.
- **W10-C:** `AddressSchema` is lowercase-only, so the client lowercases `?wallet=` before `GET /claims?wallet=`. Since W6-F1, `?wallet=` also lists the wallet's own room-round payouts (amount and proof only).

## Carry-over from W7-Z (Oct 12, 2026)

- **All:** migrations shift by one, because W7-F1 took `0020`: W10-A `0023`, W10-D `0024`.
- **W10-A:** deleted accounts (W7-B): `DELETE /me` enqueues a card re-render. Build its consumer (cards without handle or avatar) and purge the edge cache for the cards it replaces.
- **W10-C:** during the challenge window `/claims` already lists the live proposal's payouts with proof and `claimsOpenAt`, though the escrow refuses a claim until final. Show them as "claimable at" that time (decision D3).
- **W10-D:** the Coinbase Smart Wallet stand-in for the paymaster specs goes in `e2e/fixtures/wallet.ts`, which notes where (W7-D needed none: the API-level specs enter from EOAs).
