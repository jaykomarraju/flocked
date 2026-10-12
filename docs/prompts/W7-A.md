# Session W7-A: WebSocket hub and viewer shards

**Role:** build. **Size:** M (split into `W7-A.2` if needed: the upgrade route, the shards, the `state` snapshot and the fan-out first; coalescing, the Stakes messages from D1 and the 16-shard test second). **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-7.md`: the intro, "Pinned interfaces", "W7-A", and the W7-A and "All" items of every "Carry-over" section (W2-Z, W6-Z).
- `docs/sessions/W6-Z.md` (wave-6 summary). W6-F1 runs alongside you; its files are listed under "Owns" in `docs/plan/wave-6.md` "W6-F1". Don't edit them.
- Code you build on:
  - `apps/api/src/do/round-viewer-do.ts` (the stub) and `do/types.ts` (`RoundViewerDORpc`, `ViewerSubscription`, `ModeResult`);
  - `apps/api/src/rounds/hooks.ts` `broadcast()` (the seam the RoundDO calls; a no-op today) and its call sites in `do/round-do.ts` (`onModeResult`, `broadcastCounts`, the close and `revealing` messages);
  - `apps/api/src/routes/rounds.ts` (the `/rounds/:id/ws` stub behind `requireRoundAccess`) and `apps/api/src/read/access.ts`;
  - `apps/api/src/read/rounds.ts`, read only: how `GET /rounds/:id` reads D1 `round_modes` and gates on `revealed_at`. The `state` snapshot must agree with it;
  - `packages/shared/src/ws.ts`, `packages/shared/test/ws.test.ts` and `packages/shared/test/fixtures/ws/*.json`;
  - `apps/api/vitest.config.ts` (the DO bindings in tests).
- Spec sections (Node 22: `nvm use` first):
  ```bash
  pnpm spec "Real-time and the reveal"
  pnpm spec "Non-functional requirements" --sub "Scaling notes"   # only the WebSocket fan-out bullet
  pnpm spec "API" --sub "Reveal gating"
  ```
  Changed in wave 6 (Decision log, Oct 12, 2026): "Round lifecycle" (the `revealed_at` rules; the Stakes rows: the coordinator calls `finalize`, and refund_proposed → revealing opens a `refund_vetoed` hold) and "API" (Reveal gating: a round is public only once locked; room rounds answer 401 anonymous and 404 to a non-member). Read the Oct 12 rows: `pnpm spec "Out of scope, launch gates and decision log" | grep 'Oct 12'`.

## Objective
Build the live WebSocket on `GET /rounds/:id/ws`:
- the Worker upgrades the request behind `requireRoundAccess` (room rounds: members only) and routes the socket to a `RoundViewerDO` shard chosen by hash(connection id) mod N, with N = 16 by default, from config;
- each shard holds its sockets with the WebSocket Hibernation API and sends the `state` snapshot on connect and on every reconnect;
- the RoundDO's `broadcast()` seam fans each message out to every shard: `counts` coalesced to at most one per second, `closed`, `revealing`, `revealed` (Stakes carries `claimsOpenAt` once the proposal is confirmed) and `refunded` (with `provisional` and `finalAt`; W2-Z);
- no per-option data before the mode's `revealed_at`, in any message or snapshot.

The socket should take most of the polling load: today every non-cached `GET /rounds/:id` reads the RoundDO's live counts.

## Starting point
- Base: tag `wave-6`. Branch: `w7-a-ws`. Worktree: `../flocked-w7-a`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w7-a -b w7-a-ws wave-6
  cd ../flocked-w7-a && nvm use && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit:
  - `apps/api/src/ws/**` (new) and `apps/api/src/do/round-viewer-do.ts`;
  - the `broadcast()` function in `apps/api/src/rounds/hooks.ts` (not the notification hooks, which are W9-A's), and in `apps/api/src/do/round-do.ts` only the messages it hands to `broadcast()`. `wave-7.md` calls this "the `broadcast()` body in `round-do.ts`"; the seam itself is in `hooks.ts`. List every RoundDO line you change in the handoff;
  - the `/rounds/:id/ws` handler in `apps/api/src/routes/rounds.ts`, and nothing else in that file. Keep `requireRoundAccess` in front of it;
  - `packages/shared/src/ws.ts`, `packages/shared/test/ws.test.ts` and `packages/shared/test/fixtures/ws/*.json`;
  - migration `apps/api/migrations/0014_*.sql` only if you need one, with `apps/api/test/migrations.test.ts` for it;
  - `apps/api/test/ws/**` (new) and `docs/sessions/W7-A.md`.
- Must not touch:
  - W6-F1's files (`wave-6.md` "W6-F1", "Owns"), among them `indexer/handlers/stakes.ts`, `lifecycle/handlers.ts`, `settlement/**`, `do/settlement-do.ts`, `read/{cache,proofs,me,claims,rounds}.ts`, `routes/entries.ts` and `local/seam.ts`. If a message needs a change there (for example the RoundDO being told a Stakes mode is final), write it under "Notes for D";
  - W7-B's `apps/api/src/{identity,limits,auth}/**`, `routes/{me,limits,auth}.ts` and `packages/shared/src/api/me.ts`; W7-C's design files;
  - the registry files: `apps/api/src/{app,env,index}.ts`, `routes/index.ts`, `apps/api/wrangler.jsonc`, `.github/workflows/*`, root and `e2e/` `package.json`, `pnpm-lock.yaml`, `packages/shared/src/index.ts`, and `e2e/**`. Put a new var (the shard count) in "Notes for D", and code a default of 16 for when it is unset;
  - `contracts/**` (the audit candidate), `Product_Spec.md`, `Design_Language.md`, `plan.md` and `docs/plan/`.

## Pinned interfaces
- `wave-7.md` "Pinned interfaces", WS: messages per `packages/shared/src/ws.ts`; the shard is hash(connection id) mod N; the RoundDO's `broadcast()` calls `RoundViewerDO.broadcast` on every shard.
- P2.4 DO signatures in `do/types.ts`: `RoundViewerDORpc.subscribe(sub) → WsStateMessage` and `broadcast(message) → { delivered }`. Add no RPC method to `RoundDORpc`; any signature change is a note for Z.
- `ws.ts`: `refunded` gains `provisional` (true for a Stakes refund proposal not yet final) and `finalAt` (when it becomes or became final), per the spec's WebSocket table. `WsModeSnapshotSchema` keeps refusing a `result` without `revealedAt`, and `counts` carries no per-option data.

## Tasks
1. Create the worktree (above).
2. The `/ws` handler: upgrade only a GET with `Upgrade: websocket`, behind `requireRoundAccess`; pick the shard; pass `membersOnly` in the `ViewerSubscription`.
3. `RoundViewerDO`: hibernating sockets (state in `serializeAttachment`, nothing lost on wake), `subscribe`, `broadcast` returning the delivered count, and closing dead sockets.
4. The `state` snapshot: the RoundDO's live state for counts and times, and D1 `round_modes` for each mode's status, `revealed_at`, `claims_open_at` and result. The RoundDO's Stakes status stays `settle_proposed` after `RoundFinalized`, so D1 is the record (W6-Z).
5. `broadcast()`: fan out to the N shards without floating promises. Coalesce `counts` to at most one per second, trailing edge, so the last count always arrives.
6. `refunded`: fill `provisional` and `finalAt` from the `ModeResult` (`claimsOpenAt` for a Stakes proposal); say in the handoff what Free and final Stakes refunds carry.

## Tests and checks
- `pnpm check` and `pnpm format:check` green (Node 22).
- Required, in `apps/api/test/ws/**` in the Workers runtime:
  - DO-5 (reconnect snapshot): a socket that reconnects gets a fresh `state` with the current counts and status, and the result only after the reveal;
  - PIPE-1 (WS half): no message or snapshot carries per-option data before the mode's `revealed_at`, for Free and for a Stakes proposal not yet confirmed;
  - coalescing: a burst of entries yields at most one `counts` per second per socket, and the last one is current;
  - shard fan-out with 16 shards and many sockets: each socket gets each message once;
  - room rounds: anonymous 401, non-member 404 at upgrade, a member connects; a finalized Stakes mode reads as final from D1.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- `/rounds/:id/ws` serves the snapshot and every message type through 16 shards, gated and coalesced.
- The listed tests pass, and DO-5 (snapshot) and PIPE-1 (WS) are named with their tests in the handoff. The handoff is written.

## Constraints
- Never commit secrets; tests generate keys.
- Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if you're running low, follow plan.md 2.6 (`W7-A.2`).

## End of session
1. Commit, then `git push -u origin w7-a-ws`.
2. Write `docs/sessions/W7-A.md` from plan.md 3.2. Put the shard-count var, the RoundDO lines you changed, and any change needed in W6-F1's files under "Notes for D and Z". Commit and push.
3. End with your status and: "When W7-A, W7-B, W7-C and W6-F1 all report complete, start W7-D from `docs/prompts/W7-D.md`."
