# Wave 10: Stakes UI, share cards, watcher I

**Goal.** Players can enter Stakes and claim from the browser through a sponsored smart-wallet user operation. Every settled player gets a share card. The independent watcher verifies Stakes rounds.

**Base.** Tag `wave-9`. **Hold point:** OA-D4 (cards) before W10-A: confirmed frozen with no changes (owner, Oct 16, 2026, W9-Z); OA-D2 already frozen. W9-F1 runs alongside W10-A/B/C from the same tag. **Migrations reserved:** W10-A `0023`, W10-D `0024` (shifted by W7-Z, Oct 12: W7-F1 took `0020`); the watcher has its own D1 (`apps/watcher/migrations/0001`).

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
- **Read first.** `plan.md` §2, §4. `docs/sessions/W9-Z.md`. This section. `docs/sessions/W9-B.md` and `packages/verify/src/index.ts` (no README yet), `docs/bundle-format.md`. Spec: "Smart contract" (only "Challenge window, watcher and guardian").
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
- **Owns.** `apps/web/src/features/{stakes,claims}/**`, `apps/web/src/wallet/**`, `e2e/ui/{stakes-eligibility,claims}.spec.ts`; from W9-Z also `apps/web/src/features/{today,sealed,reveal}/**` and `apps/web/src/ws/**` (the Stakes toggle, the counting minimum, the reducer fix; see Carry-over from W9-Z).
- **Required tests.** AC-8 (UI absent for each ineligibility reason). Config-mismatch refusal. Screenshot comparisons. axe.

## W10-D: Paymaster proxy + Stakes UI e2e (+ merges W9-F1)

Split up front into W10-D and W10-D.2 (plan.md 2.8, W9-Z, Oct 16, 2026: it merges four branches, then builds the proxy and four Stakes UI e2e rows).

- **W10-D.**
  - **Role / size:** integrate, M.
  - **Objective.** Merge A, B, C and W9-F1 (`wave-9.md` "W9-F1"; owner decision, Oct 16, 2026) as a fourth branch; register routes and bindings; copy the watcher verdict schema into `packages/shared/src/watcher.ts`. Build the paymaster proxy:
    - sponsor only `enter`/`enterWithPermit` with a valid ticket, plus a USDC `approve(FlockedEscrow, stake)` only as the call immediately before `enter` in the same user operation;
    - `claim`, `claimRefund`, `finalize` and `withdraw`;
    - 10 sponsored user operations per user per day;
    - forward to the provider (a local bundler/paymaster mock on the stack).

    Then the paymaster accept/reject/cap rules end to end (E2E-11, `e2e/tests/paymaster.spec.ts`). Re-run a sample of W9-F1's mutations on the merged tree.
  - **Read first.** `plan.md` §2, §3.4. Handoffs W10-A, B, C and W9-F1. Spec: "Smart contract" (only "Gas and UX").
  - **Owns.** Registry files; `apps/api/src/paymaster/**`; `apps/api/src/routes/paymaster.ts`; migration `0024`; `e2e/mocks/bundler/**`; `e2e/tests/paymaster.spec.ts`; `packages/shared/src/watcher.ts`.
  - **Required tests.** E2E-11; `pnpm check` and `pnpm e2e` green.
  - **Emits.** `docs/prompts/W10-D.2.md`.
- **W10-D.2: Stakes UI e2e.**
  - **Role / size:** integrate, M. On `w10-integration`, after W10-D.
  - **Objective.** In the browser on the stack: verify personhood (mock Coinbase) and enter Stakes (E2E-1 Stakes UI), claim after the challenge window (E2E-4 UI), a settlement veto turning into refunds (E2E-5), in `e2e/ui/{stakes-round,stakes-veto}.spec.ts` from `e2e/fixtures/browser.ts` and the shape of `free-round.spec.ts`.
  - **Read first.** `plan.md` §2, §3.4. Handoffs W10-C and W10-D. `e2e/ui/README.md`.
  - **Owns.** `e2e/ui/{stakes-round,stakes-veto}.spec.ts`, `e2e/fixtures/**` (shared helpers), and the registry files only for a fix the specs need.
  - **Required tests.** E2E-1 (Stakes UI), E2E-4 (UI), E2E-5, AC-5 (UI parts); `pnpm e2e:ui` green on its own fresh stack.
  - **Emits.** W10-Z prompt.

## W10-Z checklist

- AC-7 (cards), AC-8, PIPE-5 (Stakes), E2E-1 (Stakes UI), E2E-4 (UI), E2E-5, E2E-11 proven.
- W9-F1's items (the guardian-void notice, R2–R4, the room successor, `memberCount`, the archive's `revealing`) each have a passing, mutation-checked test, and W9-F1 is merged. W9-F1's spec issue on merges and push subscriptions goes to the owner.
- Confirm OA-D3 is frozen before W11-C, and OA-D5 (Admin) before W11-A (moved up from W12 on Oct 12).
- A design subagent adds the `identity_unlinked` security notice to the Farcaster, web push and email all-events notification sheets (missing since decision B6; `docs/design/screens.md` notes it), re-exports them and re-runs `pnpm e2e:screens`.
- Migrations for wave 11: W11-A `0025`, W11-B `watcher/0002`, W11-D `0026`.

## W10-F1 and W10-F1.2: Wave-10 review fixes and the Oct 26 decisions (added by W10-Z, Oct 26, 2026; alongside W11-A/B/C, merged by W11-D)

- **Why.** Wave 10 was green, but W10-Z's four reviews found defects no test catches (4 high, about 13 medium), and the owner's Oct 26 decisions (Decision log, ten spec sections; `docs/sessions/W10-Z.md` "Decisions") need code. W11-A, B and C don't edit these files, so the owner chose the Oct 11 option (plan.md 2.6): W10-Z merged wave 10, and the fix runs alongside W11-A/B/C from the tag `wave-10`. It is split up front (plan.md 2.8): **W10-F1** (API and shared schemas) on branch `w10-f1-review-fixes`, worktree `../flocked-w10-f1`, then **W10-F1.2** (web) on the same branch and worktree, emitted by W10-F1. W11-D merges the branch as a fourth one once both are `complete`. The watcher's findings are W11-B's (it owns `apps/watcher/**`; `wave-11.md` "Carry-over from W10-Z"). W10-Z fixed the high card finding itself (the root mount served `/rounds/:id/card/*.png` without `requireRoundAccess`) and moved the Free teaser enqueue to `waitUntil`.
- **Role / size:** fix, M each. Migration `0027` reserved for W10-F1 if it needs one (W12-D moves to `0028`). No change to `contracts/src` (the audit candidate).
- **W10-F1 owns:** `apps/api/src/paymaster/**`, `apps/api/src/routes/paymaster.ts`; `apps/api/src/cards/**`, `apps/api/src/routes/cards.ts`; `apps/api/src/lifecycle/{void,handlers}.ts` and `apps/api/src/indexer/handlers/stakes.ts` (card enqueues only); `apps/api/src/scheduler/tick.ts` (the void sweep only); `apps/api/src/notify/outcomes.ts`; `apps/api/src/identity/merge.ts`; `apps/api/src/personhood/{config,flow}.ts` and the `/me/personhood` handlers (not `personhood/{eligibility,geo}.ts`, which W11-A may edit for E2 and E5); `apps/api/src/read/{me,claims}.ts`; `packages/shared/src/api/{me,claims}.ts` (additive fields only) and their tests. Not `apps/api/src/read/rounds.ts` or `src/scheduler/lock.ts` (W11-A's override list), `src/admin/**`, `src/flags/**`, `apps/watcher/**`, `apps/web/**` or the registry files.
- **W10-F1 fixes** (each with a test that fails without it, mutation-checked; findings by `file:line` on `w10-integration`):
  - **Paymaster, high:** (1) a retry with the same nonce gets the stored `paymasterAndData` back (`quota.ts:14-21,66-70`, `proxy.ts:258-259`): a rebuilt op (new fees, same nonce) can never be sponsored again. Key the replay by a hash of the whole op; a changed op asks the provider again without taking a second slot. (2) Nothing checks that the sender is a Coinbase Smart Wallet (`policy.ts:87-112`): allow `initCode` only as `0x` or the official factory's `createAccount`, check a deployed sender's proxy code and implementation, and cap the gas fields, so a new salt can't buy 10 sponsored operations a day for any account.
  - **Paymaster, medium and low:** forward only the validated v0.6 fields (re-serialised, context `null`), not the raw body (`proxy.ts:230,262`; duplicate or case-folded keys reach a provider differently); run the pure checks before the `ticketSigner` RPC read, cache it, and add a per-IP rate-limit bucket (`proxy.ts:217`); bound the nonce to uint256 (`policy.ts:96`, a 500 outside the JSON-RPC envelope today); don't pass the provider's error text through (`proxy.ts:232-233,267-269`); the cap's error code when an expired pending row exists (`quota.ts:54,77`). Check whether the Coinbase wallet calls the paymaster URL from its own origin (keys.coinbase.com) and, if so, answer CORS for it.
  - **Cards:** voided rounds never get cards (`lifecycle/void.ts:190-200`, the guardian void in `lifecycle/handlers.ts`, `indexer/handlers/stakes.ts:688` reason 4): enqueue the fan-out after the commit. A Stakes teaser at an indexed `Entered` (decision). Card TTLs `max-age=300, s-maxage=3600` and drop the edge-cache write and purge nothing reads (`routes/cards.ts:103-111`, `purge.ts:43`; decision). A deletion during a render keeps the old handle (`consumer.ts:91-101`, `identity/delete.ts:184`): write the row before rendering, or re-check after the put. Fix `enqueue.ts:137`'s comment (every Stakes final renders twice, which the veto path needs).
  - **Void sweep:** the 10-minute window is on `final_at`, the block time, so a void the indexer applies more than 10 minutes late is never told (`tick.ts:232`, `lifecycle/handlers.ts:405`): sweep by when the void was applied (a cursor in `config` or a column in `0027`). This also closes W9-F1's stateless-window open issue.
  - **Decisions (Oct 26):** a pre-beacon guardian void is told under the `refunded` key (`notify/outcomes.ts` and the sweep); a merge moves `push_subscriptions` (upsert on `endpoint`) and `notification_prefs` (pairs the kept account hasn't set); `POST /me/personhood` carries where the flow began (`from`: Today or Settings) through the OAuth state and the callback returns there with the outcome (`personhood/config.ts` `personhoodReturnUrl`); `GET /me` `stakes.net30d`; `GET /claims` items gain `gameDay` and `prompt`.
- **W10-F1.2 owns:** `apps/web/src/features/{stakes,claims}/**`, `apps/web/src/wallet/**`, `apps/web/src/ws/live.ts`, `apps/web/src/features/today/**` (the personhood outcome, the Stakes net and `dstNotice` only), the header's balance slot in `apps/web/src/layout/**`, `e2e/ui/{stakes-eligibility,stakes-entry,claims}.spec.ts` and `e2e/ui/world.ts`'s Stakes parts. Not `apps/web/src/crypto/**` (W11-C's Verify page reads it), `features/{round,archive,verify,profile,boards,share}/**` or `routes.tsx`.
- **W10-F1.2 fixes:** the entry isn't tied to the config it checked (`features/stakes/entry.ts:84-107`): refuse unless the ticket's round, `prepared.stake` and `prepared.beaconRound` equal the checked config and the encryption target, and run the target-round check for Stakes; the question on screen is never checked against `questionHash` (`configCheck.ts:169`); R5 leaves the vetoed refund's `finalAt` and `refundReason` on a settlement re-proposal (`ws/live.ts:228-236`, `mergeMode:130`); wallet errors are classified by substring (`wallet/send.ts:47-50`: classify by `name`/`code` along the `cause` chain) and `status === 'success'` is trusted without receipts (`send.ts:108`); Claims can send another wallet's payouts from the connected one (`Claims.tsx:159-163,186-190`); a refusal at the moment of entry stays until reload (`useStakesToday.ts:127,173`); `dstNotice` fires for any round not 24 h long (compare the offsets at open and close). **Decisions:** the sheet opens for `tos_not_accepted` / `age_unattested` alone (AC-8's two cases move from "absent" to the sheet); Today shows the personhood outcome when the flow began there (`?personhood=…`, failures and their reason); Claims decides "Ready" by `useServerNow()` with the socket's skew; "Claim all" sends only the connected wallet's payouts and names the others; Claims drops its per-row `GET /rounds/:id`; the header shows `stakes.net30d` whenever Stakes is selected.
- **Both:** `pnpm check`, `pnpm format:check`, and the specs they touch on a fresh stack (`stakes-round.spec.ts`, `stakes-veto.spec.ts`, `paymaster.spec.ts`; `--project=ui <file>`, then `--project=ui-warp --no-deps <file>`). W11-D re-runs a sample of the mutations on the merged tree.

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

## Carry-over from W8-Z (Oct 16, 2026)

- **W10-A:** the referral attribution window (7 days) lives in the client (owner decision, Oct 16): the server can't check its age. `GET /s/:shareId` and its "Play today's Flocked" link carry the sharer's `ref` and the share ID to the app; W11-D keeps them in the client.

## Carry-over from W9-Z (Oct 16, 2026)

- **All:** read `docs/sessions/W9-Z.md` for the spec sections changed on Oct 16. **W9-F1** (the guardian-void notice, three review fixes in `src/notify/**` and three owner decisions) runs alongside W10-A/B/C from the tag `wave-9`; its files are listed in `wave-9.md` "W9-F1". Don't edit them.
- **W10-A:**
  - `GET /rounds/:id/me` `cards` and `/s/:shareId` are what the reveal's Share already links (W9-C, `features/reveal/ShareBlock.tsx`; it falls back to `/r/:id` until a card exists); the outcome email still shows no card image (W6-Z);
  - "Got flocked again." is share text (`docs/design/screens.md`), not notification copy (owner, Oct 16);
  - OA-D4 is confirmed frozen with no changes (owner, Oct 16): build from the current card exports;
  - card enqueues go where outcomes become durable (`settlement/apply/free.ts`, `indexer/handlers/stakes.ts`, or `onModeFinal` in `settlement/hooks.ts`); `src/notify/**` is W9-F1's this wave.
- **W10-B:** `@flocked/verify` (W9-B): a disputed anchor (from a later-revoked key) is `unverifiable` (exit 2) by decision (spec, Smart contract › Stolen anchor key); a Free bundle whose null commitment meets an anchor that holds one is a mismatch (W9-Z fix); bundles are read from `GET /rounds/:id/bundles/:mode/:file` (`docs/bundle-format.md`). Its live-chain reader ran for the first time in `e2e/tests/verify-cli.spec.ts`; `RoleRevoked` and `OutcomeProposed` are scanned from the write or close block to the head, halving refused ranges down to 500 blocks.
- **W10-C:**
  - flip `STAKES_UI_ENABLED` in `apps/web/src/features/today/Today.tsx` (W9-C hid Stakes behind it; the `notPlayed` and provisional reveal states are drawn only in the sheets so far);
  - "Counting the flock…" shows for at least 1.5 s (owner decision, Oct 16; spec, Real-time and the reveal › Reveal choreography): hold a `revealed` that arrives sooner, so the state never flashes or is skipped; then tell W10-D that `e2e/ui/free-round.spec.ts` can drop its `holdRevealed` proxy;
  - W9-Z review R5: in `apps/web/src/ws/live.ts` (51–58, 78) `settle_proposed` and `refund_proposed` share a rank and `later()` takes the newer on a tie, so after a vetoed refund proposal re-proposes as a settlement, a late duplicate `refunded{provisional}` (or a stale reconnect `state`) moves the mode back to `refund_proposed`, and `modePhase` shows a refund over the result. Fix with a test;
  - match the re-exported toggles (W9-Z's design pass: the mode-toggle check on Sealed, Reveal, Stakes entry and the global states; `docs/design/screens.md` "W9-Z fixes");
  - Today stays mounted when `/me` loads late and at the close (W9-Z fix in `Today.tsx`: `usePlayed` waits for the session and reads the stored pick in the same render; the previous round's detail starts from the round on screen); keep `Today.test.tsx`'s two tests for it green;
  - the Owns list extends to `apps/web/src/features/{today,reveal,sealed}/**` and `apps/web/src/ws/**` for these items.
- **W10-D:**
  - merge W9-F1 as a fourth branch, and re-run a sample of its mutations on the merged tree;
  - build `e2e/ui/stakes-round.spec.ts` from `e2e/fixtures/browser.ts` and the shape of `free-round.spec.ts` (serial tests sharing three player pages; phases recorded in the page, since "Counting the flock…" lasts only seconds on the stack); E2E-1's personhood step in the browser belongs there (Free entry needs none);
  - CI time: the E2E `api` job is about 28 of its 40-min `globalTimeout`, the `ui` job about 9 min; if `stakes-round.spec.ts` and the paymaster spec push `api` past about 35 min, split it;
  - `POST /farcaster/webhook` is in `ENDPOINTS` now (W9-Z), with its schemas in `packages/shared/src/api/push.ts`.
