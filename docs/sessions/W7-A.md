# W7-A handoff: WebSocket hub and viewer shards

## Status
complete — `GET /rounds/:id/ws` serves the `state` snapshot and every message type through 16 `RoundViewerDO` shards, gated and coalesced.

## Summary
- **Upgrade** (`src/ws/upgrade.ts`, `routes/rounds.ts`): `requireRoundAccess` answers first (room rounds: anonymous 401, non-member 404 as for no round); only a GET with `Upgrade: websocket` is upgraded (else 400 `bad_request`). The Worker gives each connection a random ID and forwards it to shard `fnv1a(connId) mod N` (`<roundId>/<shard>`), passing `{roundId, shard, shardCount, membersOnly, connId}` in an internal header. N = `WS_VIEWER_SHARDS` (1–256), 16 when unset or invalid.
- **Shards** (`do/round-viewer-do.ts`): WebSocket Hibernation API, with `{connId, shard, membersOnly, connectedAt}` in each socket's attachment. `subscribe` binds the shard and returns the snapshot; `broadcast` checks the message against the wire schema (extra keys dropped, a `state` refused), sends it to every open socket, returns `{delivered}` and closes a socket whose send fails. The runtime answers "ping" with "pong" without waking the shard. Each shard keeps its snapshot for 1 s, patched by `counts` and dropped on any other message, so a reconnect storm costs at most one D1 read per shard per second.
- **Catch-up**: after `state`, a new socket gets, in order, events relayed in the last 30 s that its snapshot doesn't show yet. That covers events relayed during its snapshot read, and the Stakes indexer telling the RoundDO before its D1 batch lands. It also gets the latest `counts` if that arrived during the read.
- **Snapshot** (`src/ws/snapshot.ts`): the same rules as `GET /rounds/:id`. Round status and times come from D1; mode status, `revealed_at`, `claims_open_at` and refund reason from `round_modes`; the result from the current settlement row, joined only when `revealed_at` is set. Counts come from the RoundDO while the round is live, else D1. The result is then re-checked by `WsStateMessageSchema`.
- **Hub** (`src/ws/hub.ts`, behind `broadcast()` in `rounds/hooks.ts`): validates each message and coalesces `counts` per round to at most one per second (leading and trailing edge; wall time, not the game clock). Every message goes to all N shards on one promise chain per round, so order is kept; the chain never rejects. An event that fails at a shard is retried once. `whenIdle(roundId)` lets tests await delivery.
- **`refunded`** gains `provisional` and `finalAt` (`packages/shared/src/ws.ts`; a provisional Free refund is refused). A Stakes refund proposal is `provisional: true`, `finalAt` = the proposal's `claimsOpenAt`. Free refunds, final Stakes refunds (`RoundRefunded`) and voids are `provisional: false`, and `finalAt` is when the RoundDO learns of them (the game clock; the void's apply time). D1 `final_at` stays the record.

## Branch and head commit
`w7-a-ws` @ `601d526` (code; this handoff is the next commit)

## Files touched
- New: `apps/api/src/ws/{shards,snapshot,hub,messages,upgrade}.ts`, `apps/api/test/ws/{helpers,upgrade,snapshot,reveal-gating,coalescing,fanout}.ts` (`*.test.ts`), `docs/sessions/W7-A.md`.
- Edited: `apps/api/src/do/round-viewer-do.ts` (the stub, now the shard), `src/rounds/hooks.ts` (`broadcast()` only), `src/do/round-do.ts` (messages only, below), `src/routes/rounds.ts` (the `/ws` handler and its comments), `packages/shared/src/ws.ts` (`refunded`), `packages/shared/test/fixtures/ws/{valid,invalid}.json`.
- Edited tests that pinned the `/ws` stub: `test/do.test.ts` (RoundViewerDO pins: `subscribe` → `not_found` for an unlocked round, `broadcast` → `{delivered: 0}`, plain fetch 400), `test/routes.test.ts` (`GET /rounds/:id/ws` moved from `GATED_STUBS` to `IMPLEMENTED`), `test/gating/rooms.test.ts` (a member's plain GET of `/ws` is now 400, not 501).
- No migration (`0014` unused).

## Tests run
| Command | Result |
| --- | --- |
| `pnpm check` (Node 22.23.1) | pass: node:test 20, abi 13, settle 66, tlock 176, shared 459, signer 18, api 862, forge 202 |
| `pnpm format:check` | pass |
| `pnpm --filter @flocked/api exec vitest run test/ws/` | 5 files, 18 passed (~17 s) |
| Mutation checks (scratchpad script: one replacement, the WS test file, restore) | 12 of 12 caught: no coalescing; no trailing edge; fan-out to one shard; the snapshot result read without `revealed_at` (join and read); counts always from D1; no catch-up; kept snapshot not patched by counts; kept snapshot not dropped on an event; `finalAt` ignoring `claimsOpenAt`; no `revealing`; the upgrade ungated. Removing only the JOIN's `revealed_at` survives by design (the read checks it again, and the schema a third time) |

## Traceability rows covered
- **DO-5** (reconnect snapshot): `apps/api/test/ws/snapshot.test.ts` › "DO-5: a reconnect gets a fresh state" › "current counts and status at every step, and the result only after the reveal" and "an event D1 does not show yet is sent right after state…"; also `coalescing.test.ts` › "a reconnect right after a burst gets the current counts in its state", and `snapshot.test.ts` › "the snapshot a shard keeps…" (patched by `counts`, dropped by any other message, re-read after 1 s).
- **PIPE-1 (WebSocket half)**: `apps/api/test/ws/reveal-gating.test.ts` › "PIPE-1 (WebSocket)…" › "Free: nothing in the window…", "Stakes: nothing while the proposal is unconfirmed; `revealed` with claimsOpenAt once confirmed; final from D1", "a relayed message never carries more than its wire shape". These use the real Free and Stakes pipelines up to the window (`test/gating/helpers.ts`) and the leak scan `perOptionData`. Open parts of PIPE-1: cards (W10-A), log scan (W13-C).
- Coalescing: `test/ws/coalescing.test.ts` (a burst, a 2.5 s stream, three sockets). Fan-out: `test/ws/fanout.test.ts` (256 sockets over all 16 shards, each placed by hash mod 16; three RoundDO messages, each delivered 256 times; closed sockets not counted). Room rounds at the upgrade: `test/ws/upgrade.test.ts`. A finalized Stakes mode reads as final from D1 while the RoundDO says `settle_proposed`: `reveal-gating.test.ts` (Stakes test).

## Deviations
- **Three existing tests changed** because they pinned the `/ws` stub's 501 (listed above). Nothing was skipped or weakened: each now checks the implemented behaviour.
- **`revealing` is sent by the RoundDO at its beacon-time `settle` event**, for each mode still `pending` there. No `revealing` call site existed. The D1 `pending → revealing` move is in the SettlementDO (W6-F1's file), so the catch-up replays `revealing` to a socket whose snapshot still says `pending`.
- `subscribe` throws for an unknown or unlocked round (`not_found: …`) and a bad subscription (`RangeError`). The Worker never calls it over RPC; the shard's `fetch` maps these to 404 and 503.

## Spec issues
- **Real-time and the reveal › WebSocket messages (`refunded.finalAt`)**: the time a final refund "became final" is not in the `ModeResult` the RoundDO receives, so `finalAt` is when the RoundDO learns of it, a little after D1's `final_at`. Recommend the spec say so, or add `finalAt` to the refunded `ModeResult` (a `do/types.ts` change for Z).
- **Same section (`state` for a refund after reveal)**: Free rules 1–3 set `revealed_at` and have a tally but no winner. The snapshot's `result` needs `winningOption`, so a refunded mode's snapshot has `result: null`; its tally is on `GET /rounds/:id` only. Recommend accepting this (the reveal animation is for settled modes).
- **API › Reveal gating vs the Stakes indexer**: `outcomeProposedHandler` calls `RoundDO.onModeResult` (and so the `revealed` broadcast) before its D1 batch sets `revealed_at`, by milliseconds and after the chain confirmed the proposal. Recommend the gating rule define the Stakes reveal as the confirmed `OutcomeProposed`, which is what `revealed_at` records.

## Open issues
- **Bearer tokens on WebSockets** (mini app, W8): browsers can't set `Authorization` on a WebSocket, so a mini-app viewer of a room round gets 401 at the upgrade. Options: a short-lived token from an authenticated HTTP call, passed as `Sec-WebSocket-Protocol` or a query parameter.
- **Upgrade abuse limits** (W13): no per-IP limit on upgrades or sockets per shard yet. Cloudflare allows about 32k sockets per object; 50k viewers over 16 shards is about 3.1k each.
- **A Stakes proposal reorged out** moves D1 back to `revealing`, but no message tells connected viewers; a reconnect's snapshot shows it. There is no `ModeResult` for "open again".
- Real hibernation (eviction and wake) isn't exercised by the Workers test runtime. The tests check that each socket's attachment holds its state, and broadcast needs no in-memory state.

## Notes for D and Z
- **Register the shard count** (W7-D): add `WS_VIEWER_SHARDS?: string` to `apps/api/src/env.ts` (doc: "Viewer shards per round, an integer 1–256; 16 when unset (src/ws/shards.ts)"). Leaving it unset in `wrangler.jsonc` gives 16 everywhere; if an environment sets it, add it to that environment's vars check in `test/worker.test.ts`. The code reads it through a local type until then.
- **RoundDO lines changed** (`apps/api/src/do/round-do.ts`), all messages handed to `broadcast()`:
  1. lines 5–7: the file comment (W7-A's part);
  2. line 74: `import { refundedMessage } from '../ws/messages.js'`;
  3. `onModeResult`, line 475: `refunded` is now `refundedMessage(l.roundId, mode, result, now(this.env))` (adds `provisional`, `finalAt`);
  4. `applyVoid`, lines 924–925: the void's `refunded` gains `provisional: false, finalAt: t`;
  5. `runEvent` › `settle`, lines 982–985: `revealing` for each mode still `pending` after its settle job is enqueued.
  No RPC method was added and no signature changed (`RoundViewerDORpc` as pinned).
- **W6-F1's files (no edit made):** (a) optional: notify the RoundDO after the D1 batch in `indexer/handlers/stakes.ts` if the indexer gains a post-commit hook (the shard catch-up covers it today); (b) optional: the SettlementDO could hand `revealing` to `broadcast()` at its own `pending → revealing` move, instead of the RoundDO doing it at beacon time.
- Client notes (W8): the first message is always `state`, possibly followed by catch-up events; send "ping" to keep a socket alive (answered "pong"); reconnect with jitter. `refunded.provisional` marks a Stakes refund proposal ("Final at" = `finalAt`).
