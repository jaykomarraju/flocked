# Wave 2: Primitives and interfaces

**Goal.** Finish the cryptographic and onchain primitives (`@flocked/tlock`, `FlockedAnchor`, deploy scripts and generated ABIs), lay the design foundations in Paper, and pin every interface wave 3 builds against: zod schemas, WebSocket and queue messages, the full D1 schema, the API Worker skeleton with all bindings, and the shared time and ID helpers.

**Base.** Tag `wave-1`. **Hold point before W2-C:** OA-02 (Paper MCP visible in Claude Code).

---

## Pinned interfaces

### P2.1 `@flocked/tlock` (A)

```ts
export interface DrandChain { chainHash: string; publicKey: string; scheme: 'bls-unchained-g1-rfc9380'; genesis: number; period: number; }
export const QUICKNET: DrandChain;                         // pinned mainnet values
export function chainFromEnv(env: Record<string, string | undefined>): DrandChain;   // DRAND_CHAIN_HASH, DRAND_PUBLIC_KEY, DRAND_GENESIS, DRAND_PERIOD; defaults to QUICKNET
export const MIN_BEACON_DELAY = 60, MAX_BEACON_DELAY = 600;
export function beaconTime(chain: DrandChain, round: number): number;               // genesis + (round − 1) × period
export function firstRoundAtOrAfter(chain: DrandChain, t: number): number;
export function checkTargetRound(i: { chain: DrandChain; closesAt: number; beaconDelay: number; beaconRound: number; now: number;
  dailyClose?: { gameDay: string } }): { ok: true } | { ok: false; reason: TargetRoundError };
export function encodePlaintext(i: { roundRef: Uint8Array; optionIndex: 0 | 1; nonce: Uint8Array }): Uint8Array;   // 34 bytes
export function decodePlaintext(b: Uint8Array): { version: number; roundRef: Uint8Array; optionIndex: number; nonce: Uint8Array } | null;
export function roundRefFromUlid(ulid: string): Uint8Array;  export function roundRefFromChainId(id: bigint): Uint8Array;
export async function encryptPick(chain: DrandChain, beaconRound: number, plaintext: Uint8Array): Promise<Uint8Array>; // binary age, not armored
export function isCanonicalHeader(ct: Uint8Array, chain: DrandChain, beaconRound: number): boolean;
export function verifyBeacon(chain: DrandChain, round: number, signature: string): boolean;
export async function decryptWithSignature(chain: DrandChain, ct: Uint8Array, signature: string): Promise<Uint8Array>;
export async function classify(i: { ct: Uint8Array; chain: DrandChain; beaconRound: number; signature: string; roundRef: Uint8Array })
  : Promise<{ valid: true; optionIndex: 0 | 1; nonce: Uint8Array } | { valid: false; voidReason: VoidReason }>;   // VoidReason from @flocked/settle
export function commitment(ct: Uint8Array): `0x${string}`;   // keccak256(ct)
```

- **Wire format:** ciphertexts are binary age files (non-armored). JSON transports them as base64url; onchain they are `bytes`. `commitment` is keccak256 of those bytes.
- `classify` never throws for bad input; it returns a VOID reason. It requires `verifyBeacon` to have passed (it throws if the signature fails, because a bad signature must never produce VOIDs).
- Recorded quicknet beacons for tests live in `packages/tlock/fixtures/quicknet-beacons.json`.
- `packages/tlock/vectors/target-round.json`: `{ cases: [{ closesAt, beaconDelay, beaconRound, genesis, period, expectedOk, reason }] }`, all decimal strings. They mirror `createRound`'s beacon rule, and W2-D replays them through the contract (TL-4).

### P2.2 `FlockedAnchor`, deploy and ABIs (B)

- `contracts/src/FlockedAnchor.sol` implements the spec's `IFlockedAnchor`. Constructor: `(address admin, address anchorer, address receiptSigner, uint64 drandGenesis, uint64 drandPeriod)`. Receipt-signer changes use a 72 h timelock, `ANCHOR_ROLE` grants a 72 h timelock, and revocation is immediate, mirroring P1.3's built-in timelock.
- `roundKey = keccak256(abi.encode(bytes16 roundId, uint8 mode))`. In `Skipped(roundKey, reason)`, reason 1 = already written, 2 = not locked, 3 = outside time window, 4 = beacon bounds. Mismatched array lengths revert the whole call.
- The receipt EIP-712 domain is `EIP712("Flocked", "1")` on `FlockedAnchor`, so chain ID comes from `block.chainid`. The spec gives the receipt domain without a version; record in the handoff as a spec issue that version "1" is used. Receipt typehash: `Receipt(bytes16 roundId,uint8 mode,bytes32 userIdHash,uint64 stake,bytes32 commitment,uint32 seq,uint64 closesAt,uint64 beaconRound)`.
- Deploy scripts: `contracts/script/Deploy.s.sol` deploys both contracts with CREATE2 and a fixed salt, from env (`USDC`, `ADMIN`, `GUARDIAN`, `OPERATOR`, `PAUSER`, `TICKET_SIGNER`, `TREASURY`, `ANCHORER`, `RECEIPT_SIGNER`, `DRAND_GENESIS`, `DRAND_PERIOD`). On anvil it also deploys `MockUSDC`. It writes `contracts/deployments/<chainId>.json` (`{ escrow, anchor, usdc, deployBlock }`); `31337.json` is gitignored.
- `packages/abi` (`@flocked/abi`): `src/FlockedEscrow.ts`, `src/FlockedAnchor.ts`, `src/MockUSDC.ts` (`export const flockedEscrowAbi = [...] as const`), and `src/addresses.ts` (`addressesFor(chainId)`, reading committed deployment JSON for 84532 and 8453 once they exist, and the local file at runtime in local only). Generated by `packages/abi/scripts/gen.mjs` from `contracts/out`. CI checks the generated files are current.

### P2.3 Design tokens and Paper naming (C)

- `packages/shared/design-tokens.json` (owned by design sessions from now on):
  ```json
  { "version": "1",
    "color": { "light": { "bg": "#FAF7F2", "surface": "#FFFFFF", "ink": "#141414", "muted": "#8A8A8A", "line": "#E6E1D8", "accent": "#FF4F2E", "accentInk": "#FFFFFF" },
               "dark":  { "bg": "#121212", "surface": "#1C1C1C", "ink": "#F5F2EC", "muted": "#9A9A9A", "line": "#2C2C2C", "accent": "#FF5A3A", "accentInk": "#FFFFFF" } },
    "font": { "display": { "family": "Fredoka", "weights": [600, 700] }, "body": { "family": "Inter", "weights": [400, 500, 600] }, "numeric": { "family": "Inter", "features": ["tnum"] } },
    "type": { "<role>": { "font": "display|body|numeric", "size": 36, "lineHeight": 40, "weight": 700, "tracking": 0 } },
    "space": [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64],
    "radius": { "card": 16, "pill": 999 },
    "border": { "strong": 2, "default": 1.5 },
    "motion": { "<name>": { "durationMs": 175, "easing": "cubic-bezier(...)" } },
    "breakpoints": { "min": 380, "tablet": 768, "desktop": 1120 } }
  ```
  The color values above come from `Design_Language.md` and must not change without a Z-raised decision. `accentInk` for dark mode is not in the design language; the designer picks it and records a spec issue.
- **Paper file:** one file named "Flocked", with pages `Foundations`, `Components`, `Core flow`, `Social`, `Cards and notifications`, `Admin`.
- **Artboard names:** `<surface>/<screen>/<state>/<breakpoint>`, lowercase kebab-case. Example: `core/today/open-free/mobile`. Breakpoints: `mobile` (380), `tablet` (768), `desktop` (1120).
- **Exports:** `docs/design/exports/<surface>/<screen>__<state>__<breakpoint>.png` at 2x scale. These are the Playwright screenshot baselines.
- **Inventory:** `docs/design/screens.md`, one table per surface: artboard name, spec heading, route or component, states covered, export path, freeze status.

### P2.4 Shared contracts for wave 3 (D)

D implements the following. They are the pinned interfaces wave 3's parallel sessions build against.

- `packages/shared/src/api/` holds zod request/response schemas for **every** endpoint in the spec's API table, grouped by file (`auth.ts`, `me.ts`, `rounds.ts`, `entries.ts`, `claims.ts`, `questions.ts`, `boards.ts`, `rooms.ts`, `cards.ts`, `admin.ts`, `limits.ts`, `push.ts`), plus `errors.ts` (the `{error:{code,message}}` envelope and an `ErrorCode` enum). Money is a decimal-string `bigint` on the wire. Beacon-math and onchain times (ticket `expiry`, receipt `closesAt`, `stakes_tickets.expiry`, `anchors.block_timestamp`) are Unix seconds; other times are epoch ms (wording fixed by W2-Z).
- `packages/shared/src/ws.ts`: discriminated union for `state`, `counts`, `closed`, `revealing`, `revealed`, `refunded` (spec "Real-time and the reveal").
- `packages/shared/src/queues.ts`: message shapes for `settle` (`{roundId, mode, idempotencyKey}`), `decrypt-daily`/`decrypt-rooms` (`{roundId, mode, chunkKey}`), `cards` (`{roundId, mode, userId?, kind, variants}`), `notify` (`{event, userId, dedupeKey, payload}`).
- `packages/shared/src/config.ts`: the locked `config_json` schema (per-mode stake rules, fees, cap, `minEntrants`, `beaconDelay`, creator address, `free.creatorAwardBps`, award recipient). Also canonical JSON (RFC 8785), `freeConfigHash`, and `questionHash` = keccak256(abi.encode(string prompt, string label0, string emoji0, string label1, string emoji1)) over NFC-normalized, trimmed strings with "" for no emoji. Record `questionHash`'s encoding as a spec issue for Z to confirm.
- `packages/shared/src/time.ts`: New York schedule math (`dailyOpensAt`, `dailyClosesAt(gameDay)`, `gameDayOf(closesAt)`, `isoWeekOf(gameDay)`), with DST tests for 23 h and 25 h rounds.
- `packages/shared/src/ids.ts`: ULID ⇄ 16-byte binary; `packages/shared/src/eip712.ts` (ticket and receipt typed-data builders taking `chainId` and `verifyingContract`; matches P1.3 and P2.2); `packages/shared/src/alerts.ts` (alert codes `ALERT_SETTLEMENT_FAILED`, `ALERT_COMMIT_LATE`, `ALERT_SAFE_HEAD_LAG`, `ALERT_INDEXER_LAG`, `ALERT_VOID_RATE`, `ALERT_DO_ERROR`, `ALERT_SCHEDULE_GAP`, `ALERT_WATCHER`, `ALERT_FOREIGN_EVENT`); and re-exports of `VoidReason`/`RefundReason` from `@flocked/settle`.
- `apps/api/migrations/0001_init.sql`: every table, column, unique key, partial unique index, CHECK and index in the spec's "Data model". **Migration numbers are reserved per wave** in each wave file.
- `apps/api` skeleton (`@flocked/api`):
  - `wrangler.jsonc`, with bindings `DB` (D1), `BUCKET` (R2), `KV`, Durable Objects `ROUND`, `ROUND_VIEWER`, `ANCHOR`, `SETTLEMENT`, `AUTH`, `RATE_LIMIT`, `INDEXER`, queues `settle`, `decrypt-daily`, `decrypt-rooms`, `cards`, `notify` with the spec's consumer settings, `ANALYTICS` (Analytics Engine), `VECTORIZE`, `AI`, `EMAIL`, and the static-assets binding for `apps/web`. Environments `local`, `staging`, `production`; `vars` include `CHAIN_ID`, `ENVIRONMENT`, and drand vars (P2.1).
  - `src/index.ts` exports `fetch`/`scheduled`/`queue` and every DO class as a stub. `src/env.ts` defines `Env`. `src/routes/index.ts` mounts one Hono sub-app per route module (`auth`, `me`, `rounds`, `entries`, `stakes`, `claims`, `questions`, `boards`, `users`, `rooms`, `cards`, `push`, `limits`, `admin`, `paymaster`); each starts as a 501 stub owned by a later session.
  - `src/lib/`: `errors.ts`, `validate.ts` (zod middleware), `log.ts` (structured JSON logger with a redaction list that drops any field named `optionIndex`, `plaintext` or `nonce` before beacon), `clock.ts` (`now()` honours `FLOCKED_TEST_CLOCK` only when `ENVIRONMENT=local`), `turnstile.ts`, `alert.ts` (`raiseAlert(code, data)`), `auth-context.ts` (`requireUser`/`optionalUser` middleware reading `c.get('user')`; W3-A provides the session middleware that sets it).
  - `src/points/` is fully implemented: atomic movement batch builders for the spec's "Atomic points movements" (stake, credit, grant with ledger ref), with Workers-runtime tests.
  - `src/do/types.ts` pins DO RPC signatures:
    - `RoundDO`: `init(locked)`, `enterFree(req)`, `getState()`, `ingestStakesEntry(evt)`, `onModeResult(mode, result)`, `requestVoid()`.
    - `AnchorDO`: `submitLock(items)`, `submitCommit(item)`, `submitManifest(item)`, `status(roundKey)`.
    - `SettlementDO`: `start(key)`, `chunkDone(chunkKey, result)`, `status()`.
    - `AuthDO`: `consumeNonce`, `consumeEmailCode`, `bindOAuthState`, `consumeOAuthState`.
    - `RateLimitDO`: `take(bucket, cost)`.
    - `IndexerDO`: `poll()`, `status()`.
    - `RoundViewerDO`: `subscribe`, `broadcast`.
  - `vitest.config.ts` using `@cloudflare/vitest-pool-workers`, and `test/helpers/` (seeded D1, fake user and session injection, fixed clock).
- `contracts/test/TargetRound.t.sol` replays `packages/tlock/vectors/target-round.json` through `createRound` (TL-4).

---

### As built (W2-Z, Oct 8, 2026)

P2.1–P2.4 were built as pinned, with these additions; the details are in each handoff's "Deviations".
- **P2.1:** vectors add `id`, `now`, `gameDay` and `contractError`; `TargetRoundError` = `invalid_round`, `beacon_too_early`, `beacon_too_late`, `invalid_delay`, `not_first_round`, `beacon_in_past`, `wrong_daily_close`; extra exports (`TARGET_ROUND_ERRORS`, `isDailyClose`, `PLAINTEXT_LENGTH`, `PLAINTEXT_VERSION`, `toBase64Url`, `fromBase64Url`). `encryptPick` refuses non-34-byte plaintexts; `classify` throws on a non-16-byte `roundRef`.
- **P2.2 / P1.3:** escrow adds `transferGuardian`, `guardian()`, `GuardianTransferred`, `SingleGuardian`; anchor adds `getAnchor`, `receiptDigest`, `verifyReceipt`, `domainSeparator`, `operationId`, `timelockReadyAt`, `setReceiptSigner(0)`, `SKIP_*`. `lock` requires `now < closesAt`; `anchorManifest` reverts. `addressesFor(chainId, local?)`; committed data in `packages/abi/src/deployments.ts`.
- **P2.3:** dark `accentInk` `#121212`; 13 type roles, 7 motion tokens. Owner decisions (Oct 8) change light `muted` to `#6E6E6E` and add a `scrim` token (W3-C applies them).
- **P2.4:** `EndpointDef` adds `params`, `query`, `responseType`; all paths under `/api/v1`; wire primitives end in `Schema`; `raiseAlert(env, code, data)`; lowercase addresses; uppercase ULIDs; `winLine`/`lossLine(count, total)` via `formatShare`; `@cloudflare/vitest-plugin`. `MODE_CODES` = `{ free: 0, stakes: 1 }`.

## W2-A: `@flocked/tlock`

- **Role / size:** build, M.
- **Objective.** Build `@flocked/tlock` per P2.1 on `tlock-js`, with recorded quicknet beacons, canonical-header and plaintext validation, BLS signature verification and VOID classification. Prove it in Node and in the Workers runtime.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W1-Z.md`. This section (P2.1). Spec: "Sealed picks (timelock encryption)" (all), "Round lifecycle" (only "Scheduling").
- **Owns.** `packages/tlock/**`.
- **Must not touch.** Root registry files: ask D in the handoff for a script or CI change.
- **Deliverables.** The P2.1 API; `fixtures/quicknet-beacons.json` (≥ 5 real quicknet rounds fetched once from `api.drand.sh` and committed with their source URLs); `vectors/target-round.json`; `README.md`.
- **Required tests.** Vitest in Node, plus a Workers-runtime project (`vitest-pool-workers`) proving decrypt and `verifyBeacon` work there (TL-1, Workers half). TL-2, TL-3 and the TypeScript half of TL-4. A property test that `encodePlaintext`/`decodePlaintext` round-trip and the length is always 34. Timing: report ms per decrypt in the Workers runtime (input to the load test).
- **Acceptance checks.** Encrypting to a recorded round and decrypting with its recorded signature returns the plaintext. A flipped signature bit fails `verifyBeacon`, and `classify` throws. Each malformed-ciphertext case gives its exact VOID reason.
- **Risks.** tlock-js may not expose decrypt-with-given-signature directly; wrap its internals or use its `Beacon`-free path (document the approach). Bundle size for the browser.
- **Open questions.** Whether a ciphertext whose stanza targets the right round but a different chain hash is `wrong_target` or `non_canonical_header` (pick `wrong_target`; note it).

## W2-B: `FlockedAnchor`, deploy scripts, `@flocked/abi`

- **Role / size:** build, M. If it runs long, split: `.2` takes the deploy scripts and `@flocked/abi`.
- **Objective.** Implement `FlockedAnchor` with full tests, CREATE2 deploy scripts for both contracts, and the generated ABI package. First, apply the two W1-Z owner decisions to `FlockedEscrow` (wave-1.md P1.3, "Amended by W1-Z"), so the generated ABI and NatSpec match the spec: `unpause` becomes `DEFAULT_ADMIN_ROLE` only, and `GUARDIAN_ROLE` gets exactly one holder with `transferGuardian` and a `guardian()` view, which also removes the unbounded revoke loop in `executeGuardianReplacement`.
- **Read first.** `plan.md` §2, §4. `docs/sessions/W1-Z.md`. This section (P2.2). `contracts/README.md`. Spec: "Smart contract" (only "Contract: `FlockedAnchor`" and the "Stolen anchor key" residual-risk bullet), "Sealed picks (timelock encryption)" (only "Free mode specifics").
- **Owns.** `contracts/src/FlockedAnchor.sol`, `contracts/src/interfaces/IFlockedAnchor.sol`, `contracts/test/Anchor*.t.sol`, `contracts/script/**`, `contracts/deployments/**`, `packages/abi/**`. It may edit `contracts/foundry.toml` and `contracts/.gitignore`. For the two escrow decisions only: `contracts/src/FlockedEscrow.sol`, `contracts/src/interfaces/IFlockedEscrow.sol`, `contracts/test/Escrow.*.t.sol`, `contracts/test/invariant/**`, `contracts/test/utils/**`, `contracts/README.md`.
- **Must not touch.** Any other `FlockedEscrow` behaviour (record needed changes as an open issue for Z). Root registry files.
- **Deliverables.** As P2.2; Anchor unit, fuzz and an invariant ("each round key written at most once per kind").
- **Required tests.** CON-7 stays green with both escrow changes: the pauser's `unpause` reverts and the admin's succeeds immediately; `transferGuardian` moves the role at once and the old holder loses it; granting, revoking or renouncing `GUARDIAN_ROLE` reverts; `executeGuardianReplacement` costs the same whatever happened before it; the invariant suite asserts the role always has exactly one holder. CON-9; deploy script dry run on anvil (`forge script ... --fork-url http://127.0.0.1:8545 --broadcast` against a locally started anvil) with a test asserting the deployment JSON; `pnpm --filter @flocked/abi typecheck`.
- **Acceptance checks.** CON-9 passes; a receipt signed with viem's `signTypedData` using `@flocked/shared`'s future builder shape (P2.2 typehash) recovers on-chain in a Foundry test via a helper `verifyReceipt` view (add one to Anchor if useful to clients; otherwise test with `ECDSA` in the test).
- **Risks.** Batch skip semantics; time-window edges (`closesAt ≤ ts < beaconTime`).

## W2-C (design): foundations and components

- **Role / size:** design, M.
- **Objective.** Create the Paper file, build the foundations (color tokens light and dark, type scale, spacing, shape, borders, motion notes, mascot placeholder poses) and the component set every surface needs. Export the tokens file and foundation PNGs.
- **Read first.** `plan.md` §2, §5.4. This section (P2.3). `Design_Language.md` (all). Spec: "Client app" (screen table only), "Overview" (Brand vocabulary). `packages/shared/src/copy.ts`.
- **First step.** Confirm the Paper MCP tools are available. If they aren't, stop as `blocked` (OA-02). Never substitute a design invented in code.
- **Owns.** The Paper file pages `Foundations` and `Components`; `packages/shared/design-tokens.json`; `docs/design/screens.md` (create; foundations and components sections); `docs/design/exports/foundations/**`, `docs/design/exports/components/**`; `docs/design/README.md` (naming rules, how to export).
- **Components.** At least: option card (idle, hover, pressed, selected, disabled, revealed-win, revealed-loss), primary CTA pill, secondary pill, stake selector (Free presets + slider; Stakes fixed), mode toggle, countdown, entrant/pool counter, split bars (equal, animated end states, win accent), result card (unflocked, got flocked, refunded, provisional/final-at), padlock sealed badge, toast/error, empty state, skeleton loading, offline banner, tabs, list row, leaderboard row, avatar, form field (text, error), modal and bottom sheet, nav bar (mobile) and header (desktop), mascot poses (neutral, smug, walking away, shocked, flock).
- **Required checks.** Tokens JSON validates against P2.3 (a small zod check D adds; C can run `node -e` to parse). Contrast: ink/bg, muted/bg and accentInk/accent meet WCAG AA, with ratios recorded in `screens.md`. Every component has light and dark variants.
- **Definition of done.** The owner can review Foundations and Components in Paper; exports and inventory are committed. The freeze itself is OA-D1.
- **Risks.** Muted #8A8A8A on #FAF7F2 fails AA for body text (≈3.3:1). Restrict muted to large text or non-essential labels, or record a spec issue proposing a darker muted.

## W2-D: Pinned interfaces

- **Role / size:** integrate, M (if it runs long, split: `.2` takes the API skeleton and `src/points/`).
- **Objective.** Merge A, B and C. Wire `packages/tlock`, `packages/abi` and the tokens into the workspace and CI. Then implement P2.4, the contracts wave 3 builds against, plus the TL-4 forge cross-check.
- **Read first.** `plan.md` §2, §3.4, §4. This section. Handoffs W2-A, B, C. Spec: "API", "Data model", "Real-time and the reveal" (only "WebSocket messages"), "Round lifecycle" (only "Timing" and "Scheduling"), "Architecture" (table only), "Non-functional requirements" (only "Alerts").
- **Owns.** Registry files; `packages/shared/src/**` (not `design-tokens.json`); `apps/api/**`; `contracts/test/TargetRound.t.sol`.
- **Deliverables.** P2.4 in full. Two W1-Z carry-overs in `packages/shared`: a test that `@flocked/settle`'s `Mode` equals `@flocked/shared`'s (settle keeps its own copy so it stays dependency-free), and the share-percentage rule for `winLine`/`lossLine` (spec Decision log, Oct 7, 2026: whole percent, winning share rounded down, losing share rounded up, `<1%` and `>99%` at the extremes). CI hardening from the W1-Z review: every `pnpm --filter` step in `ci.yml` gets `--fail-if-no-match`, and the `properties` job runs `test/properties.test.ts` by path instead of `-t property`, so a rename can't turn either into a green no-op. Root scripts `contracts:build` (forge build + ABI codegen); CI additions (ABI freshness check; tokens schema check).
- **Required tests.** `pnpm check`; migration applies cleanly in the Workers test runtime and a test asserts every spec table and unique key exists; zod schemas round-trip fixtures; DST tests; points batch atomicity (insufficient balance rolls back); TL-4.
- **Acceptance checks.** Every endpoint in the spec's API table has a request and response schema, and every DO in the Architecture table has a stub class and an RPC interface.
- **Emits.** W2-Z prompt.

## W2-Z checklist

- W2-B applied the W1-Z escrow decisions (admin-only `unpause`; single-holder `GUARDIAN_ROLE` with `transferGuardian`), CON-7 is green, and the generated ABI includes them.
- W2-D added the `Mode` equality test, the share-percentage rule and the CI hardening.
- CON-9 and TL-2..4 proven; TL-1 (Workers half) proven.
- Raise spec issues: receipt domain version, `questionHash` encoding, dark `accentInk`, muted contrast, and any from tlock.
- Ask the owner to review Foundations and Components in Paper (OA-D1 can happen any time before W8).
- Migration numbers reserved for wave 3: W3-A `0002`, W3-B `0003`, W3-D `0004`.
- Remind the owner of OA-01 (OrbStack) before wave 3.
