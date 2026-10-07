# Flocked — Product Spec

Oct 6, 2026 · revised Oct 7, 2026 · @Jay Komarraju

## Revision notes (Oct 7, 2026)

This revision applies the decisions from the spec review, then a second review of the revision itself. The main changes:

- **Minority by headcount.** The winning side is the option fewer people picked.
- **Fixed stake in Stakes mode.** Every Stakes entry in a round has the same stake, frozen at question lock. Free mode keeps a stake range.
- **Payouts.** Within the winning side, payouts are proportional to stake.
- **One verified person, one Stakes entry.**
  - Stakes entries need an entry ticket bound to a person ID from Coinbase sign-in.
  - The person must also be ID-verified on that same Coinbase account.
- **Two options only at launch.** The contract supports exactly two.
- **No bonus pot.** Winnings above the cap go back to the losers in proportion to their stakes. Nothing carries over between rounds.
- **Real sealing.**
  - Picks are encrypted to a drand beacon 2 minutes after close.
  - Free rounds commit their beacon round at question lock and their entry set before the beacon, both onchain and write-once.
- **Bounded operator.**
  - Every parameter is frozen onchain at question lock and published.
  - Admins cannot void after close.
  - Every post-close Stakes outcome, settlement or refund, is a proposal checked against a posted tally.
  - A 2-hour challenge window with a guardian veto comes before anything is final.
  - Every VOID can be recomputed from public data.
- **Per-mode outcomes, identities and merges.** Each mode records its own outcome. Accounts can link identities and merge, with safe rules.
- **Visual language** is defined in [Design_Language.md](Design_Language.md).
- **Open questions answered.** Every remaining open question was answered on Oct 7 (see Decision log). What's left before launch is listed under Launch gates.

## Overview

Flocked is a daily minority game. There is one question with two options, and picks stay sealed until a fixed reveal time. The side fewer people picked wins the other side's stakes. Players are not stating an opinion; they are predicting what the crowd will not pick.

**Core loop:** question drops → pick a side and stake → picks sealed until close at 21:00 America/New\_York → the beacon unlocks them 2 minutes later → the minority side splits the majority's stakes → share the result card → next question.

**Product goals**

- A daily habit: one round per day with a single shared reveal moment.
- Every reveal produces a shareable artifact (the result card).
- Users supply the content: players submit questions and vote on them.
- Outcomes are verifiable:
  - nobody, including the operator, can see the split before the beacon;
  - anyone can recompute every result from public data.

**Design principles**

- One primitive: pick a side. Everything else is optional depth.
- The losing state is the meme. Losing must be funny and shareable, not just painful.
- Trust through cryptography, not promises. Picks are sealed with timelock encryption, and the operator's powers are bounded onchain.
- Free mode and Stakes mode share one engine; they differ in ledger, stake rules and identity requirements.

**Brand vocabulary** (use consistently in UI copy, API enums and events)

| Term | Meaning |
| --- | --- |
| The Flock | The majority side in a settled round (more people picked it) |
| Got flocked | The player picked the majority side and lost their stake (less any cap rebate) |
| Strays | Players on the winning (minority) side |
| Unflocked | The player's result when they win |
| Stray streak | Consecutive game days with a winning entry (see Game day) |
| Play streak | Consecutive game days with an entry |
| Game day | The New York date on which a round closes |

## Core game rules

The winning side is the option fewer people chose. Stakes decide how much a player wins or loses, not which side wins.

- In Stakes mode, each verified person gets at most one entry per round, and every entry has the same stake, so neither extra wallets nor extra money can buy the outcome.
- In Free mode, stakes vary and accounts are cheap. That is accepted because points have no value (see Anti-abuse).

**Question format**

- Prompt: 1–120 characters, plain text, preference-based (not a factual question with a correct answer).
- Options: exactly 2, each 1–24 characters, optional single emoji per option. The two options must be different after normalization (trimmed, case-folded).
- Category tag from a fixed list (food, life, tech, money, pop, hypothetical, other).
- One global question per day. Private rooms may run their own questions (see Rooms).

**Entering**

- One entry per round per mode: one per account in Free, one per verified person in Stakes (see Identity and personhood). An entry is (option, stake), and it cannot be edited or withdrawn once submitted.
- Stakes mode: a fixed stake per round (`stake`, default 5 USDC), frozen at question lock. Free mode: a stake range (default 10–100 points).
- Entries are accepted only while the round is OPEN, that is, before `closesAt`.

**Determining the winner**

- N(o) = number of valid entries on option o (headcount). W(o) = sum of valid stakes on o.
- If one option has no valid entries, or N(A) = N(B), the mode refunds (see Settlement).
- Otherwise the winning option M is the option with the smaller N, and the losing option L is the other one.
- Everyone on M is a Stray; everyone on L got flocked.

**What players can see while a round is OPEN**

- Number of entrants (live).
- Total pool size (live; in Stakes mode this is public onchain anyway).
- History signals from settled rounds only: past splits for similar categories and the crowd's recent tendencies (e.g., "the Flock picked the first option 5 days running").
- Never: per-option counts or stakes, or any partial split. This data does not exist in plaintext before the beacon.

## Round lifecycle

**Timing**

- A daily round opens at 21:00 America/New\_York and closes at 21:00 New York time the next day. On DST change days the round lasts 23 or 25 hours.
- Picks are encrypted to the first drand beacon at or after `closesAt` + `beaconDelay`. The default delay is 2 minutes; the allowed range is 60 seconds to 10 minutes.
- Each mode reveals as soon as it has settled after that beacon.
- The next round opens at the moment the previous one closes.
- All times are computed from New York wall time. Every time used in beacon math (API fields and contract fields) is in Unix seconds.

Status is tracked at two levels:

- **Round** (`rounds.status`), schedule level: `scheduled` → `open` → `closed`.
- **Mode** (`round_modes.status`), one row per round and mode:
  - `pending` → `revealing` → `settled` or `refunded`;
  - before close, a mode can go to `voided` instead.

  Stakes adds two non-terminal states that mirror the contract: `settle_proposed` and `refund_proposed`. The chain indexer moves a Stakes mode to `settled` or `refunded` only when the contract reaches that terminal state; `final_at` records when.

Picks can only be decrypted after the beacon is published. Admins can void a round only before `closesAt`.

| Level | From → To | Trigger | Actions |
| --- | --- | --- | --- |
| Round | (lock) | Question lock, 6 h before `opensAt` | Freeze config into `config_json`; create `round_modes` rows for enabled modes. Stakes: `createRound` onchain and store `chain_round_id` from the receipt. Free: lock leaf anchored onchain (see Sealed picks) |
| Round | scheduled → open | `opensAt` alarm | Load the locked config into the RoundDO; broadcast state; send `question_live` |
| Round | open → closed | `closesAt` alarm | Stop accepting entries and drain in-flight Free entries. Build each Free commitment root and send it to the AnchorDO. Stakes: start streaming `Entered` logs into chunk files |
| Round | scheduled/open → closed | Admin void before `closesAt` | Two-phase void (see below); all modes voided |
| Mode | pending → revealing | Beacon published and its signature verified (retry every 3 s for 10 min, then alert and keep retrying every 60 s until the rule-8 deadline for Free or the timeout for Stakes). Stakes also waits until Base's safe head passes the close block | Fan out decryption. When the tally is done, Free settles or refunds; Stakes posts its proposal |
| Mode (Free) | revealing → settled | Tally complete and outputs durable in R2 | Broadcast `revealed`; ledger writes; enqueue cards and notifications |
| Mode (Free) | revealing → refunded | Refund rule 1, 2 or 3 applies | Ledger refunds; broadcast `refunded`; enqueue the outcome notification |
| Mode (Free) | pending → refunded | Commitment not anchored before the beacon (rule 7), or the beacon still unavailable 24 hours after its round time (rule 8) | Ledger refunds; broadcast `refunded`; enqueue the outcome notification. Rule 8 fires from a RoundDO alarm at beacon time + 24 h, through a conditional update that applies only while the mode is still pending |
| Mode (Stakes) | revealing → settle\_proposed | Indexer sees `OutcomeProposed` (settlement) | Broadcast `revealed` with the final time; enqueue cards and the outcome notification |
| Mode (Stakes) | revealing → refund\_proposed | Indexer sees `OutcomeProposed` (refund rule 1, 2 or 3) | Broadcast `refunded`, marked provisional, with the final time; enqueue the outcome notification |
| Mode (Stakes) | settle\_proposed → settled | `claimsOpenAt` passes with no veto. The indexer calls `finalize` (gasless) and sees `RoundFinalized` | Set `final_at`; apply stats, streaks and boards; send `payout_claimable` |
| Mode (Stakes) | settle\_proposed → refunded | Indexer sees `ProposalVetoed` on a settlement (reason 5) | Mark the settlement superseded; replace payouts with refunds; recompute; broadcast `refunded`; re-render cards; send `refunded`; audit log entry |
| Mode (Stakes) | refund\_proposed → refunded | `claimsOpenAt` passes with no veto; `RoundFinalized` | Set `final_at`; send `refunded` |
| Mode (Stakes) | refund\_proposed → revealing | Indexer sees `ProposalVetoed` on a refund proposal (round back to Open) | Mark the proposal superseded; alert; settle again |
| Mode (Stakes) | pending / revealing → refunded | Indexer sees `RoundRefunded` with reason 1 (`refundTooFew`) or 6 (timeout) | Refund; broadcast `refunded`; enqueue the outcome notification (or `refunded` if the outcome was already sent) |
| Mode (Stakes) | pending → voided | Indexer sees `RoundRefunded` with reason 4 before close that the backend didn't start (a guardian void) | Stop Stakes tickets; broadcast `refunded`; notify; alert. Free continues |

**Void (before close only)**

- The RoundDO stops accepting entries as soon as a void is requested.
- If the round has a Stakes mode, `voidRound` must confirm in a block stamped before `closesAt`. If it does not, the void is abandoned and every mode follows the normal close path.
- A voided game day is neutral for streaks. The guardian can also void a Stakes mode on its own before close (see the table above).
- The next round keeps its scheduled `opensAt`; until then clients show the empty state.

**Scheduling**

- A scheduler cron Worker creates rounds in D1 48 hours ahead. The question and config can change until the **question lock**, 6 hours before `opensAt`. At lock, everything is frozen.
- At lock, Stakes rounds call `createRound` onchain with every parameter: times, `beaconRound`, stake, fees, cap, `minEntrants`, creator address and question hash. Free rounds anchor a lock leaf. Nothing in a locked round can change; the only option is to void it before close.
- `beaconRound` = the first drand quicknet round whose time is at or after `closesAt + beaconDelay`. Round time is `genesis + (round − 1) × period`, with quicknet genesis 1692803367 and a 3-second period.
- Durations, `beaconDelay` and timezone are per-round config, kept for special events after launch. At launch, every daily and room round closes at 21:00 America/New\_York. A non-default close is accepted only if it is in the published locked config with an audit-log ID, and clients show it prominently.
- At any moment there is at most one OPEN daily round and usually one more in reveal or settlement. Clients and APIs handle both.

## Sealed picks (timelock encryption)

Picks are encrypted in the client to a future drand beacon round, so no one, including the operator, can read any pick before that beacon is published. The beacon comes at least 60 seconds (2 minutes by default) after the last entry can be accepted, so nobody can learn anything about the split while entries are still open. This replaces commit-reveal, which would force every player to come back and reveal. For Stakes this assumes Base is producing blocks at close (see Residual risk, Base halt).

**Scheme**

- Use drand timelock encryption (tlock, via the `tlock-js` library) against the drand quicknet chain. `packages/tlock` pins these, matching the contract:
  - the chain hash, public key and scheme (`bls-unchained-g1-rfc9380`);
  - genesis and period;
  - `MIN_BEACON_DELAY` (60 s) and `MAX_BEACON_DELAY` (10 min).
- The client builds a fixed-length 34-byte plaintext:

  | Bytes | Field |
  | --- | --- |
  | 1 | version = 0x01 |
  | 16 | round reference: the 16-byte binary ULID of the round (Free), or the onchain round ID as a big-endian uint128 (Stakes) |
  | 1 | `optionIndex` (0 or 1) |
  | 16 | random nonce |

  The plaintext length is fixed, so the ciphertext length can't reveal the option. The client encrypts it to `beaconRound` and submits the ciphertext with the stake. The plaintext is not bound to the entrant: a copied ciphertext counts as a blind copy of someone's pick, which is accepted (see Anti-abuse).
- **The client checks the target round before encrypting.** It refuses to encrypt unless all of these hold:
  - `beaconRound` is the first quicknet round at or after `closesAt + beaconDelay`;
  - `closesAt + MIN_BEACON_DELAY ≤ beaconTime(beaconRound) ≤ closesAt + MAX_BEACON_DELAY`;
  - the beacon time is in the future;
  - for daily and room rounds, `closesAt` is 21:00 America/New\_York on the displayed game day;
  - the values match the round's onchain record, read through a public Base RPC the API does not control. For Stakes, every `RoundConfig` field must equal the published locked config (see Round config check below). For Free, the lock leaf in `FlockedAnchor` must match.
- **Round config check (Stakes).**
  - At lock, the full `RoundConfig` (every field), the author's handle and payout address, and any non-default value with its audit-log ID are published on `/rounds/:id` and `/rounds/today`.
  - The client compares every onchain field against that record and refuses to build `enter` on any mismatch.
  - It also checks the values against the launch defaults (stake 5 USDC, 500/100 bps, cap 10, `minEntrants` 20 for daily rounds and 3 for Stakes rooms) and shows any non-default value prominently.
  - The watcher snapshots the published config at lock and checks it independently of the backend.
- Server stores the ciphertext and `commitment = keccak256(ciphertext)`. It cannot read the option.
- After the beacon is published, the settlement job fetches its signature and verifies it with BLS against the pinned quicknet public key for exactly `beaconRound` before any decryption. A signature that fails is discarded and fetched again. Relays are used only for availability.
- Every ciphertext is decrypted with that one verified signature. Settlement never uses tlock-js's own beacon lookup, so the result does not depend on when decryption runs.

**Canonical ciphertext header**

- A valid ciphertext has exactly one recipient stanza. It is of type tlock, with exactly two arguments: `beaconRound` in canonical decimal and the pinned quicknet chain hash.
- Anything else is VOID. The Free entry endpoint rejects it at submit, and the client never produces it.

**Stakes mode specifics**

- The deposit transaction emits the full ciphertext in an event, so the complete entry set is recoverable from chain data alone.
- Stakes are public (and fixed per round); only the chosen option is sealed.
- The client builds the `enter` call itself from its ciphertext and the entry ticket. The server never sees or returns calldata containing a pick.
- **Entry set.** The close block is the last Base block stamped before `closesAt`. Stakes settlement counts exactly the `Entered` events for the round up to the close block. It starts only once Base's safe head has passed the close block. It reconciles the log count and stake sum against the contract's `entryCount` and `roundBalance` at that block before tallying. On any mismatch it retries against a second RPC provider and alerts, and does not post a result. The round stays Open, with the 72-hour timeout as the backstop.

**Free mode specifics**

- **Lock leaf.** At question lock, every Free round (daily and room) is anchored through `FlockedAnchor`. The leaf commits `closesAt`, `beaconRound`, the question hash and a config hash covering stake range, cap, `minEntrants`, creator award and `beaconDelay`. The anchor contract enforces the same beacon-delay bounds as the escrow.
- **Receipts.** Every accepted entry gets an EIP-712 receipt signed by the receipt key. The domain is "Flocked", the chain ID of the deployment network (8453 for Base mainnet in production, 84532 for Base Sepolia in staging, the local chain in tests), verifying contract `FlockedAnchor`. The receipt covers `(roundId, mode, userIdHash, stake, commitment, seq, closesAt, beaconRound)`, where:
  - `userIdHash` = keccak256(abi.encode(roundId, userId));
  - `seq` is the entry's sequence number in the round.

  The client recovers the signer and checks it against the receipt signer published onchain. It also checks every field against its own request, including `commitment` = keccak256 of its own ciphertext. A mismatch is shown as an error and kept as evidence. This also catches a server that swapped the pick or served a wrong beacon round.
- **Commitment anchored before the beacon, once.**
  - At close, the RoundDO builds a Merkle tree over its committed receipt leaves.
  - The AnchorDO posts the root to `FlockedAnchor`, which stores exactly one commitment per (round, mode) and reverts on a second write.
  - The contract also rejects a commitment in a block stamped at or after the locked beacon time.
  - If no commitment is confirmed before the beacon, that Free mode is refunded (rule 7).
- Free settlement tallies exactly the anchored leaf set. Any D1 entry outside it is VOID (`not_anchored`) and refunded.
- The Verify page checks the user's receipt against the anchored root. The full entry file is published after settlement.

**Invalid entries**

- An entry is VOID if any of these hold:
  - the ciphertext fails to decrypt;
  - its header is not canonical;
  - it targets a round or chain other than the round's committed `beaconRound` on quicknet (Stakes: the `RoundConfig`; Free: the lock leaf);
  - the plaintext is not exactly 34 bytes, its version isn't 0x01, or its round reference doesn't equal the round's binary ULID (Free) or `chain_round_id` as a big-endian uint128 (Stakes);
  - `optionIndex` isn't 0 or 1;
  - Free only: it is not in the anchored leaf set;
  - Free only: its stake is outside the locked stake range.
- A VOID entry is excluded from tallies and its stake refunded in full. In Stakes the refund is a payout leaf.
- Every VOID reason can be recomputed from public data: chain data, drand, and the bundle with its anchored commitments. The watcher treats any VOID it cannot recompute as a mismatch.
- **Safety net.** If a round's VOID rate is anomalous, settlement holds and alerts instead of posting. This is a delay only; the timeout still bounds Stakes.

**Client requirements**

- Encryption happens before any network call carrying the pick. The plaintext option is never sent to the server.
- After submit, the client stores its decoded plaintext (round, `optionIndex`, nonce) and the receipt locally so it can show "your pick" before the reveal. If local storage is lost, the UI shows "Your pick is sealed" until the reveal.

## Settlement and payout math

Strays get their stake back plus a share of the losers' stakes after fees, in proportion to stake. Winnings are capped at 10x the stake. Anything above the cap goes back to the losers in proportion to their stakes. All math uses integer arithmetic in base units (USDC has 6 decimals; points are integers), rounding down. Implementations use `bigint`; JavaScript `number` is not allowed for money. The bundle manifest records the formula version.

Each mode settles independently.

**Definitions**

- s\_i = stake of valid entry i. N(o) = headcount on option o. W(o) = sum of s\_i on option o. T = sum of all valid s\_i. V = sum of VOID stakes.
- M = the winning option (smaller N). L = the losing option. W\_M = W(M). Loss pool Lp = W(L).

**Refund rules** (every stake returned; nothing carries forward)

| Code | Rule | Applies to |
| --- | --- | --- |
| 1 | Fewer than `minEntrants` valid entries (default 20 in Stakes, 1 in Free; room rounds: fewer than 3 qualifying entrants, see Rooms) | Both |
| 2 | One-sided: an option has no valid entries | Both |
| 3 | Headcount tie: N(A) = N(B) | Both |
| 4 | Voided before `closesAt` by an admin (any mode) or the guardian (Stakes) | Both |
| 5 | Guardian veto of a settlement proposal during the challenge window | Stakes |
| 6 | No outcome proposed within `REFUND_TIMEOUT` (72 hours) after close; anyone can trigger it | Stakes |
| 7 | Commitment not anchored before the beacon | Free |
| 8 | Beacon still unavailable 24 hours after its round time (Stakes is covered by rule 6) | Free |

- Rules 1–3 are checked in order 1, 2, 3, and the first that applies sets the reason. For example, 10 vs 0 with `minEntrants` 20 is rule 1, not rule 2.
- A round has at most one entry per account: one per wallet and one per person in Stakes, one per user in Free.
- `minEntrants` ≥ 1 and `capMultiple` ≥ 1 in every mode (the Stakes launch ceilings allow `capMultiple` 1–10).
- A refunded round pays no creator fee (Stakes) and no creator award (Free).

**Normal case**

```latex
\begin{aligned}
F &= \lfloor Lp \cdot feeBps / 10000 \rfloor \\
C &= \lfloor Lp \cdot creatorBps / 10000 \rfloor \\
D &= Lp - F - C \\
w_i &= \min\left(\lfloor D \cdot s_i / W_M \rfloor,\ capMultiple \cdot s_i\right) \quad (i \text{ on } M) \\
R &= D - \textstyle\sum_{i \text{ on } M} w_i \\
r_j &= \lfloor R \cdot s_j / Lp \rfloor \quad (j \text{ on } L) \\
payout_i &= s_i + w_i \quad (i \text{ on } M), \qquad payout_j = r_j \quad (j \text{ on } L) \\
dust &= R - \textstyle\sum_{j \text{ on } L} r_j
\end{aligned}
```

- Defaults: `feeBps` = 500, `creatorBps` = 100, `capMultiple` = 10. All three are frozen at question lock. In Stakes (fixed stake, 6% fees) the 10x cap binds only when winners are under about 8.6% of valid entries (N\_L/N\_M > 10/0.94). In Free it binds whenever W(L)/W(M) > 10, which uneven stakes can cause at any split.
- Fees are charged on the whole loss pool, even when the cap sends most of it back to the losers (decided Oct 7; see Decision log).
- R, the rebate pool, is whatever the capped winners don't take. When the cap doesn't bind, R is only rounding remainder and rebates are effectively zero.
- Bounds: every Stray gets between s\_i and (1 + capMultiple)·s\_i, and every loser gets between 0 and s\_j. Dust is below the number of losing entries.
- In Stakes, dust goes to the treasury. In Free, dust is burned: it is recorded in the settlement but credited to no one.
- In Stakes, C goes to the creator address frozen at question lock. That is the payout wallet the author chose in Settings, if all of these hold at lock:
  - the author is verified and not suspended or self-excluded;
  - the wallet is linked to the author;
  - its Verified Account and Verified Country attestations are unrevoked, and the country matches the author's OAuth country and is on `geo.stakes.allow`;
  - the author passed a request-location check when setting the payout wallet (only a pass flag and its time are stored).

  Otherwise C goes to the treasury, as it does for house questions.
- In Free, the formula runs with `feeBps` = 0 and `creatorBps` = 0. The author separately receives a house-minted creator award of ⌊Lp · `free.creatorAwardBps` / 10000⌋ points (default 100 bps), outside the invariant. Room rounds pay no creator award.

**Stakes closed form.** In Stakes every entry has the same stake s, so the payout depends only on the headcounts N\_M, N\_L and the VOID count n\_V:

- Lp = N\_L·s, and F, C, D follow from the normal case.
- Winnings w = min(⌊D / N\_M⌋, capMultiple·s), rebate pool R = D − N\_M·w, rebate r = ⌊R / N\_L⌋, dust = R − N\_L·r.
- Each winner receives s + w, each loser r, and each VOID entry s.

The contract computes these amounts itself from the posted headcounts.

**Invariant** (must hold for every settlement; enforce in code and tests)

```latex
\sum_{i \text{ on } M} payout_i + \sum_{j \text{ on } L} payout_j + \sum_{v \in VOID} s_v + F + C + dust = T + V
```

In Stakes, T + V is the round's onchain `roundBalance`.

**Settlement output**

- A settlement record: per-option N and W, M, Lp, F, C, D, R, dust, and the VOID count.
- A payout list sorted by account, hashed into a Merkle tree. Every Merkle tree in Flocked (payouts and Free commitments) follows OpenZeppelin's StandardMerkleTree: the leaf values below are ABI-encoded and double-hashed, and pairs are sorted. The tree is built with `@openzeppelin/merkle-tree` and verified with OpenZeppelin's `MerkleProof`. Identifier encodings:
  - roundId and userId are 16-byte binary ULIDs;
  - the Stakes round is the onchain uint256 round ID;
  - mode is a uint8 (0 = free, 1 = stakes);
  - `userIdHash` = keccak256(abi.encode(roundId, userId)).

  The leaves:
  - Stakes payout leaf: (uint256 chainRoundId, address account, uint8 kind), where kind is win, rebate or void\_refund. The contract derives each kind's amount, so the leaf needs no amount. Rebate leaves are omitted when r = 0.
  - Free payout leaf: (bytes16 roundId, bytes32 userIdHash, uint256 amount).
  - Free commitment leaf (the receipt): (bytes16 roundId, uint8 mode, bytes32 userIdHash, uint64 stake, bytes32 commitment, uint32 seq); `closesAt` and `beaconRound` are committed by the lock leaf.
- A public verification bundle in R2:
  - A manifest with:
    - formula version, round config, `beaconRound`, the drand chain hash and the verified signature (the relay used is logged outside the manifest, so the manifest stays byte-identical across retries);
    - for Stakes, the close block number and hash; for Free, the anchored commitment root and anchor transaction;
    - the settlement record, the payout root, and the list of chunks.
  - Entry chunks of about 5,000 entries each. Each chunk has its own hash and per-option totals.
  - Chunks hold each entry's account, stake, decrypted option, nonce, validity and VOID reason. Free chunks also hold ciphertexts and receipts. Room chunks flag whether each entry counts toward the room minimum. Stakes ciphertexts are left out because they are onchain.
  - `bundleHash` = keccak256 of the manifest. It is posted in the Stakes proposal and anchored write-once through `FlockedAnchor` for Free.

## Modes: Free and Stakes

Both modes run on the same daily question, round engine and settlement code. They differ in ledger, stake rules, identity requirements and availability. Each mode is gated by its own feature flag (`mode.free.enabled`, `mode.stakes.enabled`). A flag change affects rounds locked after the change. Turning off `mode.stakes.enabled` also stops new tickets immediately, as an emergency kill switch.

|  | Free | Stakes |
| --- | --- | --- |
| Currency | Points (integer) | USDC on Base |
| Ledger | D1 `point_balances` + `points_ledger` | `FlockedEscrow` contract |
| Starting balance | 500 points on signup | Wallet balance |
| Daily grant | +100 points per daily round, credited on the user's first visit or entry after the round opens, only if balance < 1,000 (ledger ref = round ID, so it is credited once) | None |
| Stake | 10–100 points (default range) | Fixed per round (default 5 USDC) |
| Fees | None in the formula; the author gets a house-minted creator award | feeBps 500, creatorBps 100 |
| Min entrants | 1 | 20 |
| Entry limit | One per account | One per verified person (entry ticket) |
| Auth | Farcaster or wallet (SIWE) | Wallet (SIWE) plus verified Coinbase sign-in |
| Availability | Everywhere | Allowed jurisdictions only (see Compliance) |
| Integrity anchor | Lock leaf and commitment root onchain (write-once); signed receipts | Config, entries and outcome onchain |
| Settlement | Server-side ledger writes | Outcome proposed onchain; final and claimable after a 2-hour challenge window |

**Rules shared by both modes**

- A user may enter both modes in the same round (one entry per mode), and may pick differently in each. Free and Stakes tallies are settled independently, so each mode has its own split and its own winners.
- The reveal screen shows the user's mode by default, with a toggle to see the other mode's split once it has revealed.
- Points have no cash value and cannot be transferred, purchased or redeemed.

## Identity and personhood

A user is a person. A person can sign in several ways, and Stakes needs proof that each person enters only once.

**Identities**

- `users` represents the person. The `identities` table holds every way they sign in or prove control: provider (farcaster, wallet, email or coinbase) and an external ID, unique across all users.
- New accounts are created with Farcaster or a wallet (SIWE). A verified email can be linked and then used to sign in, but it cannot create a new account.
- A signed-in user links another identity by proving control of it: SIWE for a wallet, Farcaster auth, an email code, or Coinbase sign-in.
- Wallets already verified on the user's Farcaster account are offered for linking automatically.
- A user cannot remove their last sign-in-capable identity (wallet, Farcaster or verified email).
- Once a person ID is bound to a user, the coinbase identity cannot be removed.
- A wallet cannot be unlinked while it has Stakes entries in a round that isn't final or has unclaimed payouts.
- **Account deletion** (`DELETE /me`) is allowed once none of the user's rounds is still waiting to become final. It is refused while the user is self-excluded or suspended. Before confirming, the app lists any unclaimed Stakes payouts and offers "Claim all".
  - Deletion anonymizes the profile (handle, display name, avatar, prefs), removes identities and sessions, and sets `status = deleted`. It also anonymizes every account merged into it and expires its pending merges.
  - Ledger and stats rows stay under the opaque user ID. Deleted accounts are excluded from boards, streaks and profiles. Their share cards are re-rendered without handle and avatar, and the edge cache is purged.
  - `person_id` is cleared from the user but kept in a tombstone with the daily cap state. If the same person verifies a new account later, it inherits that state. Deleting is the one way to remove a bound coinbase identity.
  - Unclaimed Stakes payouts stay claimable onchain by the wallet. `GET /claims?wallet=` serves proofs from public bundle data, so a connected wallet can claim without an account.
  - The privacy policy says that onchain data and published bundles can't be erased.

**Merging accounts**

- If an identity being linked already belongs to another account, the link creates a pending merge. Nothing merges automatically, and never inside an OAuth callback.
- The user confirms the merge in an authenticated session by signing in to the other account with one of its own sign-in identities.
- A merge is refused if any of these hold:
  - either account has entries in a round that isn't final;
  - the accounts have different person IDs;
  - either account is suspended or self-excluded;
  - the kept account already received a merge in the last 30 days.
- The account with the earlier `created_at` is kept. It takes:
  - the non-null person ID and its verification data;
  - the lower daily stake cap and any pending cap increase, with its original timer;
  - the losing account's sign-in identities;
  - its point balances, per scope, through paired `merge` ledger rows;
  - its room memberships (room balances summed) and any room ownership.
- The losing account is marked `status = merged` with `merged_into`, and its sessions are revoked. Its unclaimed Stakes payouts and refunds stay visible in the kept account's Claims. Pending and confirmed merges are tracked in `merges`.
- Competitive history is not moved. Entries, payouts, cards and stats stay under the losing account's ID, which is excluded from boards and streaks. The kept account's stats count only its own entries.
- Every merge is written to `audit_log`.

**Personhood (verified Coinbase sign-in)**

- Coinbase Verifications puts an onchain attestation on up to three wallets per Coinbase account, with nothing linking those wallets to each other. On its own, it cannot enforce one entry per person. The person ID therefore comes from the Coinbase account itself, and the account must be ID-verified.
- **Flow.** The user signs in with Coinbase (OAuth 2.0 with PKCE where supported) with scopes `wallet:user:read` and `identity:user:address:read`.
- **State.** The OAuth state is single-use and bound in `AuthDO` to the user who started the flow. The callback attributes the result only to that user, never to whatever cookie arrives.
- **Verification.** The server reads the Coinbase user ID from `GET /v2/user`, and the primary address from `GET /v2/user/personal-details` (Coinbase's ID verification provides it).
- **What's stored.**
  - `person_id` = HMAC-SHA256(`PERSON_ID_KEY`, Coinbase user ID). The raw Coinbase ID, legal name and address are never stored.
  - Only the address's country and region codes.
  - `kyc_status = verified` only if personal details are returned.
- **Verified** means `person_id` is set and `kyc_status = verified`. This one definition is used for tickets, Stakes rooms, global boards and room distinctness.
- **Country.** Coinbase's Verified Country attestation (EAS on Base, issued by Coinbase's attester and looked up through Coinbase's attestation indexer) on a linked wallet drives geo-fencing. It must equal the country from the same OAuth account. Every ticket checks the Verified Account and Verified Country attestations again, unrevoked.
- **No stored tokens.** OAuth tokens are discarded after the callback. Ongoing status relies on the per-ticket attestation checks; re-verifying the account needs a fresh Coinbase sign-in.
- **Residual risk.** A verified Coinbase user who lends their account to someone else is accepted residual risk.
- `PERSON_ID_KEY` cannot be rotated without every user redoing Coinbase sign-in, because raw IDs aren't stored.

**Entry tickets (Stakes)**

- `/prepare` issues an EIP-712 ticket `(roundId, wallet, personTag, expiry)`. Its domain is name "Flocked", version 1, the chain ID of the deployment network (as for receipts), verifying contract `FlockedEscrow`. It is signed by the ticket signer key.
  - `personTag` = HMAC(`PERSON_TAG_KEY`, "flocked/personTag/v1" ‖ person\_id ‖ roundId). It changes every round, so the tag itself adds no link across rounds. Entries from the same wallet are still linkable by address, and a player can enter from different linked wallets.
  - Tickets expire after 5 minutes.
  - Every issued ticket is recorded in `stakes_tickets`, and the row is committed before the signer signs.
  - Issuance is serialized per person through a conditional D1 insert: at most one live ticket per person per game day.
  - A new ticket for the same round is issued only after the previous one has expired, plus 30 seconds.
- A ticket is issued only if all of these pass:
  - the round's Stakes mode exists and is open, and `mode.stakes.enabled` is on;
  - the user is verified;
  - the wallet is linked to the user;
  - the verified country (matching the OAuth country) and the request location are both allowed;
  - age and ToS attestations are current;
  - the user is not suspended or self-excluded;
  - the round's stake fits in the remaining daily cap for the game day, counting indexed stakes and live tickets;
  - the person has no Stakes entry in this round yet;
  - for Stakes room rounds: the user is a member whose account was created at least 24 hours before `closesAt`.
- `enter()` requires a valid ticket used by the wallet it was issued to, and rejects a second entry from the same `personTag` in a round.
- The indexer maps each `Entered` event to its user through `stakes_tickets` by (roundId, personTag, wallet), not through current wallet links.
- Every entry that passed `enter()` counts in the tally.
- An `Entered` event with no matching ticket record is a signer-compromise incident, not a VOID. In response:
  - the contract is paused;
  - the ticket signer is disabled immediately;
  - the guardian vetoes that round's settlement, which is a full refund.

  Entries are never VOIDed selectively for this.
- Self-exclusion and cap decreases block new tickets immediately. A ticket already issued stays usable until it expires, so the change is fully in effect within 5 minutes.

## Smart contract

Two contracts on Base, written in Solidity with Foundry, with no upgradeable proxy:

- `FlockedEscrow` holds all Stakes-mode USDC with per-round accounting.
- `FlockedAnchor` holds write-once commitments for Free rounds and the receipt signer.

Every post-close outcome is a proposal checked against a posted tally. Nothing is final until a 2-hour challenge window passes. A stolen operator key can propose a wrong tally, but cannot move money anywhere except to that round's entrants, the frozen creator and the treasury. Any wrong proposal is checkable against public data and can be vetoed.

**Contract: `FlockedEscrow`**

```solidity
interface IFlockedEscrow {
    enum Status { None, Open, SettleProposed, RefundProposed, Settled, Refunded }
    enum Kind { Win, Rebate, VoidRefund }

    struct RoundConfig {
        uint64  opensAt;
        uint64  closesAt;
        uint64  beaconRound;      // drand quicknet round the picks are encrypted to
        uint128 stake;            // fixed stake for every entry in the round
        uint16  feeBps;
        uint16  creatorBps;
        uint8   capMultiple;
        uint32  minEntrants;
        address creator;          // question author's payout address, or treasury
        bytes32 questionHash;     // keccak256 of the canonical prompt + both options
    }

    struct EntryTicket {
        uint256 roundId;
        address wallet;
        bytes32 personTag;        // per-round person tag (see Identity and personhood)
        uint64  expiry;
    }

    event RoundCreated(uint256 indexed roundId, RoundConfig cfg);
    event Entered(uint256 indexed roundId, address indexed player, bytes32 indexed personTag, bytes32 ticketHash, bytes ciphertext);
    event OutcomeProposed(uint256 indexed roundId, Status status, uint32 n0, uint32 n1, uint32 nVoid,
                          bytes32 payoutRoot, bytes32 bundleHash, uint64 claimsOpenAt);
    event ProposalVetoed(uint256 indexed roundId, bytes32 evidenceHash);
    event RoundFinalized(uint256 indexed roundId, Status status);
    event RoundRefunded(uint256 indexed roundId, uint8 reason);
    event Claimed(uint256 indexed roundId, address indexed player, Kind kind, uint256 amount);
    event RefundClaimed(uint256 indexed roundId, address indexed player, uint256 amount);

    function createRound(RoundConfig calldata cfg) external returns (uint256 roundId);          // OPERATOR_ROLE
    function voidRound(uint256 roundId) external;                                              // OPERATOR or GUARDIAN, before closesAt
    function enter(uint256 roundId, bytes calldata ciphertext,
                   EntryTicket calldata ticket, bytes calldata ticketSig) external;
    function enterWithPermit(uint256 roundId, bytes calldata ciphertext,
                             EntryTicket calldata ticket, bytes calldata ticketSig,
                             uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
    function propose(uint256 roundId, uint32 n0, uint32 n1, uint32 nVoid,
                     bytes32 payoutRoot, bytes32 bundleHash) external;                        // OPERATOR_ROLE
    function veto(uint256 roundId, bytes32 evidenceHash) external;                            // GUARDIAN_ROLE
    function finalize(uint256 roundId) external;                                               // anyone
    function refundTooFew(uint256 roundId) external;                                           // anyone
    function refundTimeout(uint256 roundId) external;                                          // anyone
    function claim(uint256 roundId, Kind kind, bytes32[] calldata proof) external;
    function claimRefund(uint256 roundId) external;
    function withdraw() external;                                                              // treasury and creators pull fees
    function pause() external; function unpause() external;                                    // pause: PAUSER_ROLE; unpause: DEFAULT_ADMIN_ROLE
    function transferGuardian(address newGuardian) external;                                   // GUARDIAN_ROLE; the role always has exactly one holder
}
```

**Constants** (all immutable)

- drand `GENESIS` and `PERIOD` are set in the constructor and immutable: quicknet's 1692803367 and 3 s on mainnet, and a local drand network's values in tests. `beaconTime(r) = GENESIS + (r − 1) × PERIOD`.
- `MIN_BEACON_DELAY` (60 s), `MAX_BEACON_DELAY` (10 min).
- `MAX_ROUND_DURATION` (3 days), `CHALLENGE_WINDOW` (2 hours), `REFUND_TIMEOUT` (72 hours).
- Launch ceilings: stake 1–100 USDC, `feeBps ≤ 500`, `creatorBps ≤ 100`, `capMultiple` 1–10.

**Rules the contract enforces**

- **`createRound`** assigns the next round ID from a counter, so nobody can claim an ID the scheduler will use. It reverts unless all of these hold:
  - `block.timestamp < opensAt < closesAt ≤ opensAt + MAX_ROUND_DURATION`;
  - the stake, fees and cap are within the launch ceilings;
  - `minEntrants ≥ 1`;
  - `creator ≠ 0`;
  - `beaconRound ≥ 1` (drand has no round 0);
  - `closesAt + MIN_BEACON_DELAY ≤ beaconTime(beaconRound) ≤ closesAt + MAX_BEACON_DELAY`.

  The contract supports exactly two options.
- **`voidRound`** works only while the round is Open and `block.timestamp < closesAt`. It moves the round to Refunded with reason 4.
- **`enter`** reverts unless all of these hold:
  - the round is Open and the contract isn't paused;
  - `opensAt ≤ block.timestamp < closesAt`;
  - the ticket is signed by the current ticket signer, `ticket.roundId == roundId`, `ticket.wallet == msg.sender` and it hasn't expired;
  - the ciphertext is 64–2,048 bytes;
  - `personTag ≠ 0`;
  - neither this address nor this `personTag` has entered the round, so a round has at most one entry per wallet and one per person.

  It pulls exactly `stake` USDC, checking that its own balance rose by exactly `stake`, and records the entry, `roundBalance` and `entryCount`. The `Entered` event's `ticketHash` is the ticket's EIP-712 digest.
- **`refundTooFew`** can be called by anyone on an Open round after `closesAt` if `entryCount < minEntrants`. It moves the round to Refunded with reason 1.
- **`propose`** (OPERATOR\_ROLE) requires all of these:
  - the round is Open;
  - `beaconTime(beaconRound) ≤ block.timestamp < closesAt + REFUND_TIMEOUT`;
  - `n0 + n1 + nVoid == entryCount`;
  - `bundleHash ≠ 0`.

  What it does depends on the posted tally:
  - **Refund proposal.** If `n0 + n1 < minEntrants`, or `n0 == 0`, or `n1 == 0`, or `n0 == n1`, the round becomes RefundProposed with the matching reason, and `payoutRoot` must be zero. The rules are checked in order 1, 2, 3, and the first that applies sets the reason (10 vs 0 with `minEntrants` 20 is reason 1).
  - **Settle proposal.** Otherwise the round becomes SettleProposed, and `payoutRoot` must be nonzero. The contract derives the winning option, F, C, w, r and dust from the closed form, and records the payout root.

  Either way it sets `claimsOpenAt = block.timestamp + CHALLENGE_WINDOW`. No USDC moves at proposal.
- **`veto`** (GUARDIAN\_ROLE) works only before `claimsOpenAt`:
  - on a SettleProposed round, it moves the round to Refunded with reason 5. The vetoed proposal's tally, payout root and amounts stay readable in `getRound` as evidence;
  - on a RefundProposed round, it returns the round to Open and clears the proposal, so the operator must propose again (the timeout remains the backstop).

  The `evidenceHash` is emitted with the veto.
- **`finalize`** can be called by anyone at or after `claimsOpenAt`:
  - SettleProposed → Settled: fees plus dust are credited to the treasury's withdrawable balance and the creator fee to the creator's;
  - RefundProposed → Refunded.

  `claim` and `claimRefund` finalize first if needed.
- **`refundTimeout`** can be called by anyone on an Open round once `block.timestamp ≥ closesAt + REFUND_TIMEOUT`. It moves the round to Refunded with reason 6.
- **`claim`** requires a Settled round. It also requires:
  - a valid Merkle proof for OpenZeppelin StandardMerkleTree leaf `keccak256(bytes.concat(keccak256(abi.encode(roundId, msg.sender, uint8(kind)))))`;
  - that the caller entered the round;
  - one claim per address.

  The amount is derived from `kind` (s + w, r or s). Per-kind claim counts cannot exceed N\_M, N\_L and nVoid, so total claims can never exceed the round's posted total. A rebate claim reverts when r = 0, since the tree has no rebate leaves then.
- **`claimRefund`** requires a Refunded round and pays the caller's stake once. Every entrant can claim, whatever the refund reason, including entries a vetoed settlement had counted as VOID. A refunded round credits no fees and no creator fee.
- **`withdraw`** pays out credited fee balances (pull pattern), so a creator address that cannot receive USDC never blocks a round. It pays only the credited address (`msg.sender`); there is no `withdrawTo`. A credited address that can't receive USDC, for example one on Circle's blocklist, stays credited until it can, and its balance counts as an obligation, so it can't be rescued.
- **State machine.** Settled and Refunded are terminal. There are three routes to an outcome:
  - Open → SettleProposed → Settled, or → Refunded by veto.
  - Open → RefundProposed → Refunded, or back to Open by veto.
  - Open → Refunded directly: void before close, too few entries, or timeout.

  A round can never be both settled and refunded. `RoundRefunded(reason)` is emitted on every move into Refunded, including `finalize` of a refund proposal (alongside `RoundFinalized`).
- **Roles:**
  - `DEFAULT_ADMIN_ROLE` (multisig). It grants `OPERATOR_ROLE` and sets the ticket signer and treasury behind a 72-hour onchain timelock. Revocations, disabling the ticket signer (setting it to zero) and pause take effect immediately. Only `DEFAULT_ADMIN_ROLE` executes or cancels a scheduled change, and scheduled changes don't expire.
  - `OPERATOR_ROLE` is the backend key.
  - `GUARDIAN_ROLE` is a separate guardian multisig that can veto and void before close. Exactly one address holds the role at any time. The guardian can hand it to a new address with `transferGuardian`, immediately; it can't grant the role to anyone else or renounce it. The admin multisig can replace the guardian only behind a 7-day public timelock, and the replacement is a single write, so a compromised guardian can be rotated without redeploying.
  - `PAUSER_ROLE` can pause but not unpause. Only `DEFAULT_ADMIN_ROLE` can unpause (immediately), so a stolen pauser key can't undo a pause. Pauser grants take effect immediately. Pause blocks `enter` only; proposals, vetoes, claims, refunds and withdrawals always work.
- **No locked funds.** Every USDC unit deposited through `enter` belongs to exactly one round, and every round ends Settled or Refunded with a claim path for each entrant. USDC sent to the contract by other means can be rescued only above the contract's outstanding obligations, by the admin multisig behind the timelock.
- USDC is the only accepted token. The address is set in the constructor.

**Residual risk**

- **Never proposing.** A malicious operator can avoid a result by never proposing, which ends in the 72-hour timeout refund. It is slow and public, and moves no money to anyone but the entrants.
- **Deliberately wrong proposal.** An operator who has seen the result can force a full refund within about 2 hours by proposing a wrong settlement that the guardian must veto. The wrong tally is publicly provable as operator fault. The guardian charter treats it as a key-compromise incident that requires revoking `OPERATOR_ROLE`.
- **False veto.** A guardian can veto a correct settlement, which also ends in a full refund. The guardian charter covers conflicts of interest, and the watcher alerts on any veto that doesn't match a mismatch it reported.
- **Key-compromise response.** A stolen operator or guardian key can grief rounds in these ways but cannot take funds. The response is to revoke the role, pause entries, rotate keys (the guardian through its timelock), and if needed redeploy and migrate.
- **Fake people.** The operator, as ticket issuer, could mint tickets for fake people. With a fixed stake, extra heads lose money (about 6% of their stake in fees), so this cannot buy an outcome profitably. It is detectable only through operator records.
- **Stolen anchor key.** It can pre-empt `lock` for a round key it learns, which denies service to that Free round (the round is re-keyed with a new ID before `opensAt`). It can also pre-empt `anchorManifest`, which leaves that bundle unverifiable. `ANCHOR_ROLE` is granted behind the timelock and revoked immediately, and `@flocked/verify` reports each anchor's sender and marks anchors from a later-revoked key as disputed.
- **Base halt at close.** If Base stalls at close for longer than the 2-minute beacon delay, catch-up blocks could include Stakes entries made after the picks became readable. Base halts are rare (one of about 33 minutes in Aug 2025). This is accepted residual risk (decided Oct 7).

**Contract: `FlockedAnchor`**

```solidity
interface IFlockedAnchor {
    // roundKey = keccak256(abi.encode(roundId, mode))
    event Locked(bytes32 indexed roundKey, uint64 closesAt, uint64 beaconRound, bytes32 questionHash, bytes32 configHash);
    event Committed(bytes32 indexed roundKey, bytes32 commitmentRoot, uint32 entryCount, uint64 totalStake);
    event ManifestAnchored(bytes32 indexed roundKey, bytes32 manifestHash);
    event ReceiptSignerSet(address signer, uint64 validFrom);
    event Skipped(bytes32 indexed roundKey, uint8 reason);

    function lock(bytes32[] calldata roundKeys, uint64[] calldata closesAts, uint64[] calldata beaconRounds,
                  bytes32[] calldata questionHashes, bytes32[] calldata configHashes) external;    // ANCHOR_ROLE
    function commit(bytes32[] calldata roundKeys, bytes32[] calldata roots,
                    uint32[] calldata entryCounts, uint64[] calldata totalStakes) external;       // ANCHOR_ROLE
    function anchorManifest(bytes32 roundKey, bytes32 manifestHash) external;                     // ANCHOR_ROLE
    function receiptSigner() external view returns (address);
}
```

- **`lock`** is write-once per round key. It enforces the same beacon-delay bounds as `createRound`.
- **`commit`** is write-once per round key and requires the key to be locked. It also requires `closesAt ≤ block.timestamp < beaconTime(beaconRound)`.
- **`anchorManifest`** is write-once per round key and only after beacon time.
- The receipt signer is set by the admin multisig behind the same 72-hour timelock, and its full history is in events.
- In a batch, an invalid item is skipped and reported in a `Skipped` event, while valid items still apply. Invalid means already written, not locked, or outside its time window. The AnchorDO checks each key's onchain state before building or retrying a batch.
- A stolen anchor key can front-run commitments, which only forces refunds; it cannot choose outcomes (see Residual risk).

**Challenge window, watcher and guardian**

- Stakes outcomes become final, and Stakes claims open, 2 hours after the proposal.
- An independent watcher runs on separate infrastructure under a separate account. It publishes a signed verdict (match, mismatch, or unable to verify) for every:
  - Stakes `RoundCreated`, checked against the config published at lock and against rules that don't depend on the backend:
    - for house questions, creator = treasury;
    - otherwise, creator holds unrevoked Verified Account and allowed Verified Country attestations;
    - the stake, fees, cap and `minEntrants` are the defaults unless a matching override was published before lock.

    A mismatch pages the guardian to `voidRound` before close.
  - Stakes proposal, by full recompute from chain data, drand and the bundle. This includes a check that the payout leaves match the derived amounts and the tally, and that every VOID reason can be recomputed from public data.
  - Stakes void and `refundTooFew`;
  - Free lock, commitment and manifest anchor;
  - Free settlement and refund. A rule-8 refund is a match only if the watcher's own drand monitoring saw the beacon missing at beacon time + 24 h; otherwise the verdict is unable to verify.
- Guardian signers are paged on any mismatch, unable-to-verify, or missing verdict 30 minutes after a proposal. The missing-verdict check runs as a dead-man's switch outside both the watcher and the operator.
- **Guardian policy:**
  - veto any settlement proposal still unverified 30 minutes before `claimsOpenAt`;
  - keep a veto-capable signing quorum reachable whenever any challenge window is open (normally 21:00–23:30 ET, but proposals can come later);
  - every proposal pages the on-call signer;
  - acknowledge pages within 15 minutes.

**Gas and UX**

- Target smart wallets (Coinbase Smart Wallet) with a paymaster, so entering costs the user zero ETH. Batch approve (or permit) and `enter` in one user operation.
- Claims, refund claims and `finalize` can be gasless the same way. Provide a "Claim all" UI that batches multiple rounds.
- The paymaster sponsors only: `enter` or `enterWithPermit` with a valid ticket, plus a USDC `approve(FlockedEscrow, stake)` only as the call right before that entry in the same user operation; and `claim`, `claimRefund`, `finalize` and `withdraw`. The cap is 10 sponsored user operations per user per day, so one "Claim all" batch counts once.

## Architecture

Flocked runs on the Cloudflare developer platform, plus these external systems:

- drand for timelock beacons;
- Base for Stakes money and anchors (RPC providers, bundler and paymaster);
- Coinbase for sign-in and verifications;
- Farcaster for auth, notifications and casts;
- the Anthropic API (Claude Sonnet 5.5) for moderation.

It uses TypeScript everywhere, in one monorepo (pnpm workspaces), deployed with wrangler.

| Component | Cloudflare product | Responsibility |
| --- | --- | --- |
| Client app | Workers static assets | React SPA; tlock encryption and target-round checks; receipt checks; smart wallet; mini app SDK |
| API Worker | Workers | REST API, auth, validation, rate-limit calls, OG/share pages |
| Ticket signer | Separate Worker or managed signer | Signs entry tickets; holds no other key |
| RoundDO | Durable Objects | Live round state, Free entries, receipts, commitment root, alarm chain, WebSocket hub (hibernation) |
| RoundViewerDO | Durable Objects | WebSocket fan-out shards for large reveals |
| AnchorDO | Durable Objects | A singleton that holds the anchor key and its nonce. It signs and broadcasts every `FlockedAnchor` transaction and replaces stuck ones. Commitments are grouped by `beaconRound`: the daily round's goes alone right after close, and room commitments are posted as they arrive. Each key's deadline is min(close + 90 s, beaconTime − 30 s) |
| SettlementDO | Durable Objects | One per (round, mode). Tracks decrypt chunks, triggers the reduce step when all are done, idempotent |
| AuthDO | Durable Objects | Single-use nonces, email codes and OAuth state; attempt counters |
| RateLimitDO | Durable Objects | Per-user and per-IP token buckets |
| Scheduler | Workers Cron Triggers | Create rounds 48 h ahead; question lock (`createRound`, Free lock leaves); fill gaps with house questions; daily official cast |
| Chain indexer | Workers Cron Triggers (every minute) + an IndexerDO that polls every few seconds via alarms, from `closesAt` − 5 min until proposals confirm + RPC | Mirror every `FlockedEscrow` and `FlockedAnchor` event into D1. Owns asynchronous Stakes transitions (proposal, veto, any refund, finalize) and calls `finalize` at `claimsOpenAt`. Reorg handling via `indexer_state` |
| Settlement coordinator | Queues (`settle`) | At beacon time: verify the signature. Stakes entry chunks are prepared between close and the beacon. Fan out decryption, reduce, run `@flocked/settle`, write outputs to R2, post the proposal (Stakes), apply D1 writes in idempotent chunks. The manifest is a deterministic function of chain data, the drand round and the settlement inputs (no relay identity), so retries give a byte-identical `bundleHash`, and bundle objects are write-once |
| Decrypt workers | Queues (`decrypt-daily`, `decrypt-rooms`) | One message per chunk of about 500 ciphertexts, stored in R2 (message carries only the R2 key). Settings: `max_batch_size` 1, `cpu_ms` 60,000, `max_concurrency` 250 |
| Card + notify consumers | Queues (`cards`, `notify`) | Render share cards; send notifications |
| Moderation | Anthropic API (Claude Sonnet 5.5) + Workers AI embeddings + Vectorize | Question rubric and duplicate detection |
| Watcher | Separate account; Workers Cron | Re-verify every round and anchor; publish verdicts; page guardian signers |
| Storage | D1, R2, KV | Relational data; bundles, chunks, cards, assets; short-lived nonce and code hashes |
| Analytics | Workers Analytics Engine | Event stream |

**Repository layout**

```
apps/web          React client
apps/api          API Worker, Durable Objects, cron, queue consumers
apps/signer       Ticket signer
apps/watcher      Independent verification watcher
packages/settle   pure settlement math + Merkle (shared by api, web, verify, tests)
packages/tlock    thin wrapper over tlock-js: pinned chain config, header and signature validation
packages/verify   verification library and CLI (npx @flocked/verify)
packages/shared   zod schemas, types, enums, brand copy, mascot components
contracts         Foundry project: FlockedEscrow, FlockedAnchor
```

## Data model

D1 (SQLite) is the system of record for everything except Stakes balances, which live onchain. IDs are ULIDs. Stored timestamps are UTC epoch milliseconds, while beacon-math values (`opens_at`, `closes_at` in API payloads, `beacon_round` times) are exchanged in Unix seconds. Money is integer base units.

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | id, handle (unique), display\_name, avatar\_url, role (user, admin), status (active, suspended, merged, deleted), merged\_into (nullable), prefs\_json (show\_card\_amounts, show\_stakes\_net, creator payout wallet), age\_attested\_at, tos\_version, tos\_accepted\_at, kyc\_status, person\_id (unique, nullable), person\_verified\_at, ref\_code (unique, random), coinbase\_country, coinbase\_region, created\_at | One row per person |
| `identities` | id, user\_id, provider (farcaster, wallet, email, coinbase), external\_id, verified\_at, data\_json | Unique (provider, external\_id). Wallet external\_id = lowercase address; data\_json holds attestation UIDs and verified country. Coinbase external\_id = person\_id |
| `questions` | id, author\_user\_id (nullable for house), prompt, options\_json, category, status (submitted, rejected, queued, scheduled, used), moderation\_json, score, created\_at | options\_json = exactly 2 entries of {label, emoji} |
| `question_votes` | question\_id, user\_id, value (+1/−1), created\_at | PK (question\_id, user\_id) |
| `rounds` | id, kind (daily, room), room\_id (nullable), question\_id, opens\_at, closes\_at, beacon\_round, status (scheduled, open, closed), locked\_at, config\_json | config\_json is frozen at question lock: per-mode stake rules, fees, cap, minEntrants, beaconDelay, the resolved Stakes creator address, `free.creatorAwardBps` and the award recipient. The Free config hash is keccak256 of its canonical JSON encoding |
| `round_modes` | round\_id, mode (free, stakes), status (pending, revealing, settle\_proposed, refund\_proposed, settled, refunded, voided), refund\_reason, chain\_round\_id (Stakes), lock\_tx, commitment\_root and commit\_tx (Free), bundle\_hash, revealed\_at, claims\_open\_at (Stakes, from the onchain proposal), final\_at (when the mode reached a terminal state) | PK (round\_id, mode). Created at question lock. The two `_proposed` states are Stakes only |
| `stakes_tickets` | ticket\_hash (PK), round\_id, person\_tag, user\_id, wallet, expiry, issued\_at, used\_tx | Index (round\_id, person\_tag); partial unique (round\_id, person\_tag) WHERE used\_tx IS NOT NULL |
| `entries` | id, round\_id, mode, user\_id, wallet (nullable), person\_tag (Stakes), stake, ciphertext (nullable after archival), commitment, receipt\_seq (Free), tx\_hash, block\_number, log\_index (Stakes), option\_index (null until reveal), valid (null, 1, 0), void\_reason, created\_at | Unique (round\_id, mode, user\_id); unique (tx\_hash, log\_index) |
| `settlements` | round\_id, mode, proposal\_seq, outcome (settled, refunded, voided), formula\_version, tally\_json (per-option headcount and stake), winners\_json, loss\_pool, fee, creator\_fee, distributable, rebate\_pool, dust, payout\_root, manifest\_r2\_key, bundle\_hash, settled\_at, tx\_hash, superseded\_at | PK (round\_id, mode, proposal\_seq); partial unique (round\_id, mode) WHERE superseded\_at IS NULL. A vetoed proposal is kept, marked superseded |
| `payouts` | round\_id, mode, user\_id, wallet, kind (win, rebate, void\_refund, refund), amount, claimed\_at, claim\_tx | Stakes: claimed via contract; Free: written to ledger immediately |
| `point_balances` | user\_id, scope ('global' or a room id), balance CHECK (balance >= 0), updated\_at | PK (user\_id, scope) |
| `points_ledger` | id, user\_id, scope, delta, reason (signup, daily\_grant, room\_grant, stake, payout, rebate, refund, void\_refund, creator\_award, referral, merge, admin), ref\_id, created\_at | Unique (user\_id, scope, reason, ref\_id). Append-only; never update rows |
| `user_stats` | user\_id, mode, rounds\_played, wins, losses, refunds, stray\_streak, best\_stray\_streak, play\_streak, net (points or USDC units), updated\_at | Daily rounds only; Stakes results count once final |
| `rooms` | id, name, owner\_user\_id, invite\_code, question\_source (daily, custom), created\_at | Free mode only unless flag set |
| `room_members` | room\_id, user\_id, role (owner, member), joined\_at |  |
| `share_cards` | share\_id (PK, opaque random), round\_id, mode, user\_id, kind (result, teaser), r2\_prefix, created\_at | Unique (round\_id, mode, user\_id, kind). Variants per card: og, embed, square |
| `merges` | id, kept\_user\_id, losing\_user\_id, identity\_id, status (pending, confirmed, refused, expired), expires\_at, created\_at, confirmed\_at | confirmed\_at enforces the 30-day merge limit |
| `referrals` | referrer\_user\_id, referee\_user\_id, status (pending, qualified, rewarded), qualified\_round\_id, rewarded\_at, created\_at | Unique (referee\_user\_id). Only daily rounds qualify |
| `sessions` | id\_hash, user\_id, expires\_at, created\_at, user\_agent | Session cookie (web) or Bearer token (mini app) holds the unhashed ID |
| `notification_prefs` | user\_id, channel (farcaster, webpush, email), event, enabled |  |
| `push_subscriptions` | id, user\_id, endpoint, keys\_json | Web push |
| `limits` | user\_id, daily\_stake\_cap, pending\_cap, pending\_cap\_effective\_at, self\_exclusion\_started\_at, self\_exclusion\_until, self\_exclusion\_permanent, exclusion\_lift\_requested\_at, exclusion\_lift\_effective\_at, question\_block\_until | Responsible play. A raised cap waits in pending\_cap for 24 hours. Excluded means `self_exclusion_until` > now, or permanent and not yet lifted (`exclusion_lift_effective_at` unset or in the future). Every check uses this one rule |
| `indexer_state` | chain\_id, contract, last\_block\_number, last\_block\_hash, updated\_at | If the stored hash no longer matches the chain, re-index from 5 blocks back |
| `anchors` | id, kind (lock, commit, manifest), round\_keys\_json, tx\_hash, block\_timestamp, created\_at | One row per `FlockedAnchor` transaction |
| `audit_log` | id, actor (user, admin, system), action, target, data\_json, created\_at | Every admin action, merge and settlement |
| `analytics_events` | Not stored in D1; sent to Workers Analytics Engine | See Analytics |

**Archival.** After a mode is final, its entries' ciphertexts are removed from D1, but only once they are durable in R2 bundle chunks (Free, including refunded and voided modes, which also write a bundle) or onchain (Stakes). This keeps D1 well under its 10 GB limit.

SIWE nonces and email codes live in KV with a 5-minute TTL, stored only as hashes. `AuthDO` atomically consumes each one and counts attempts.

**Status enums:** `rounds.status` is `scheduled`, `open` or `closed`. `round_modes.status` is `pending`, `revealing`, `settle_proposed`, `refund_proposed`, `settled`, `refunded` or `voided`. The two `_proposed` values are Stakes only.

**Atomic points movements.** Every points movement is one D1 batch, which runs as a single transaction. It updates the balance for the right scope (`'global'` for daily rounds, the room id for room rounds) and inserts the ledger row. This covers signup, grants, stakes, payouts, rebates, refunds, creator awards, referrals, merges and admin adjustments.

A stake runs this batch:

1. `INSERT INTO point_balances (user_id, scope, balance, updated_at) VALUES (:u, :scope, 0, :now) ON CONFLICT DO NOTHING`
2. `UPDATE point_balances SET balance = balance - :stake WHERE user_id = :u AND scope = :scope`
3. the entry insert, with its `receipt_seq`
4. the ledger insert

If the balance is insufficient, step 2 fails the CHECK, the whole batch rolls back, and the entry is rejected. Credits use `INSERT … ON CONFLICT (user_id, scope) DO UPDATE SET balance = balance + :amount`. The ledger's unique key makes settlement retries fail instead of crediting twice. Balance rows are created at signup and at room join. A nightly job reconciles `point_balances` against `points_ledger`.

## API

A single Worker serves a JSON REST API under `/api/v1`. The standalone web app uses session cookies (HttpOnly, SameSite=Lax). Inside the mini app, a Bearer token is issued in exchange for the Farcaster Quick Auth token. Every request body is validated with zod, and errors are returned as `{error: {code, message}}`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | /auth/siwe/nonce | none | Issue SIWE nonce |
| POST | /auth/siwe/verify | none | Verify signature, create session (and account if new) |
| POST | /auth/farcaster | none | Verify Farcaster Quick Auth token; return a session (cookie or Bearer token) |
| POST | /auth/email/start | none | Send a sign-in code to an already-linked, verified email |
| POST | /auth/email/verify | none | Verify the code, create session |
| POST | /auth/logout | user | End session |
| GET | /me | user | Profile, balances, limits, flags, verification status, Stakes eligibility |
| PATCH | /me | user | Handle, display name, notification prefs, card and profile prefs, creator payout wallet |
| POST | /me/tos | user | Accept the current ToS version and age attestation |
| POST | /me/identities/link | user | Link a wallet, Farcaster account or email; returns a pending merge if the identity belongs to another account |
| POST | /me/merges/:id/confirm | user | Confirm a pending merge after signing in to the other account |
| DELETE | /me/identities/:id | user | Unlink an identity (see Identities for limits) |
| POST | /me/email | user | Add an email address and send a verification code |
| POST | /me/email/verify | user | Verify the email code |
| POST | /me/personhood | user | Start Coinbase sign-in; returns the authorize URL |
| GET | /me/personhood/callback | state | OAuth callback: authenticated by the single-use state; sets verification or creates a pending merge |
| GET | /me/referrals | user | Referral status and rewards |
| GET | /rounds/today | none | Current daily round: question, options, opensAt, closesAt, beaconRound, beacon time, entrant counts, pools, and the full locked config (Stakes: every `RoundConfig` field, chain round ID, author handle and payout address) |
| GET | /rounds/:id | none | Round detail; per-mode settlement once that mode has revealed |
| GET | /rounds?before=&limit= | none | Archive of settled rounds |
| POST | /rounds/:id/entries | user | Free entry: {stake, ciphertext, turnstileToken?}. Returns the signed receipt. Stakes entries are onchain and are rejected here |
| POST | /rounds/:id/entries/stakes/prepare | user | Run eligibility checks and return a signed entry ticket for {wallet} |
| GET | /rounds/:id/me | user | The caller's entries, receipts and inclusion proofs, result, payout, claim proof |
| GET | /rounds/:id/verify | none | Bundle manifest and chunk URLs |
| GET | /rounds/:id/ws | none | WebSocket upgrade to a viewer shard for the round |
| GET | /claims | user or wallet | Unclaimed Stakes payouts and refunds with proofs and claim-open times, including accounts merged into the caller. With `?wallet=`, served from public bundle data without sign-in |
| GET | /questions?status=queued&sort=top | none | Questions in the voting queue |
| POST | /questions | user | Submit a question (runs moderation synchronously) |
| POST | /questions/:id/vote | user | {value: 1 or −1} |
| GET | /leaderboards/:board?mode=&period= | none | Boards: strays (daily), streaks, weekly, creators |
| GET | /users/:handle | none | Public profile and stats |
| POST | /rooms | user | Create room |
| POST | /rooms/join | user | {inviteCode} |
| GET | /rooms/:id | member | Room detail, members, current round, room leaderboard |
| POST | /rooms/:id/questions | owner | Set a custom question for the next room round (before its question lock) |
| GET | /s/:shareId | none | HTML page with OG and Farcaster embed tags pointing to the card images |
| GET | /cards/:shareId/:variant.png | none | Share card image from R2 (variant: og, embed, square) |
| GET | /rounds/:id/card/:variant.png | none | Generic round card (split only); 404 until the mode has revealed |
| DELETE | /me | user | Delete the account (see Identities) |
| POST | /push/subscribe | user | Register web push subscription |
| PUT | /me/limits | user | Set the daily stake cap (increases take effect after 24 hours; decreases are immediate). Start or lengthen a self-exclusion (timed to longer, or to permanent); shortening or ending one is rejected |
| POST | /me/limits/exclusion-lift | user | Request lifting a permanent exclusion: accepted only 6 months after it started; takes effect 7 days later |
| POST | /admin/users/:id/role | admin | Set role (user, admin) |
| \* | /admin/\* | admin | See Admin console |

**Reveal gating:** no endpoint, WebSocket message, card or bundle exposes per-option data for a mode until that mode's `revealed_at` is set. Room round endpoints, WebSockets and bundles are for members only. The room-minimum qualification flag in room bundles is operator-attested, which is accepted for points-only rooms.

**Rate limits** are enforced in Durable Objects.

- Per user: entries 10/min, question submissions 3/day, votes 60/min, other writes 30/min, merges 1 inbound per 30 days.
- Per IP: unauthenticated auth endpoints. IPs are kept only for the rate-limit window.
- Email codes: 8 digits, 5 attempts per code, about 10 codes per hour per address. Every new email sign-in and every newly linked identity sends the user a notice.
- Unauthenticated reads are cached at the edge for 5 seconds.

## Real-time and the reveal

Each round has one `RoundDO` (Durable Object). It owns live counters, accepts Free entries, issues receipts, builds the Free commitment root, fans out WebSocket messages and drives the round's alarms. Each mode reveals to everyone at the same moment.

**RoundDO responsibilities**

- Hold `{status, beaconRound, beaconTime, modes: {free: {status, entrantCount, pool}, stakes: {status, entrantCount, pool}}}` in DO storage.
- **Accept Free entries** in one commit protocol:
  1. Check status = open, `now < closesAt`, and that a Free `round_modes` row exists. Check room membership for room rounds, and a canonical header targeting the locked `beaconRound`. Check that the stake is an integer within the locked range, and that the user is active and not self-excluded (the single exclusion rule in `limits`).
  2. Dedupe by user and reserve the next `seq`.
  3. Commit the atomic points batch to D1, with `receipt_seq` in the entry insert.
  4. Only on success, record the leaf, sign and return the receipt, and increment counters.

  In-flight entries are tracked.
- **At `closesAt`:**
  1. Set status = closed and wait for in-flight entries to finish.
  2. Reconcile leaves against D1.
  3. Build the root from committed leaves only, and send it to the AnchorDO.
- Ingest Stakes entries from the chain indexer and update counters.
- Use WebSocket hibernation; broadcast counter updates at most once per second, coalesced.
- Chain alarms in its single alarm slot:
  - `opensAt` → open;
  - the `closing_soon` and `streak_at_risk` notification times;
  - `closesAt` → closed;
  - beacon time → enqueue settlement with idempotency key (roundId, mode);
  - beacon time + 24 h → Free rule-8 refund if the mode is still pending.
- On each mode's settlement, receive the result from the settlement coordinator and broadcast `revealed` for that mode.

**WebSocket messages (server → client)**

| type | payload |
| --- | --- |
| `state` | Full snapshot on connect |
| `counts` | entrantCount and pool per mode (no per-option data) |
| `closed` | closesAt reached; entries locked; beacon time |
| `revealing` | Settlement started for a mode |
| `revealed` | For one mode: per-option headcounts and totals, winning option and (roundId, mode). For Stakes it is sent once the proposal is confirmed onchain and carries `claimsOpenAt` |
| `refunded` | For one mode: refund reason code |

**Reveal choreography**

- Between close and the beacon (2 minutes), clients show a countdown: "Unsealing in 1:42".
- After the beacon, clients show "Counting the flock…" until `revealed` arrives for their mode.
  - Small rounds reveal within seconds of the beacon.
  - At full scale, the target is p95 under 2 minutes after the beacon. For Stakes it is measured from the later of the beacon and the safe head passing the close block.
- The coordinator broadcasts `revealed` as soon as the settlement record, payout root, manifest and chunks are durable in R2. Per-entry D1 writes follow in idempotent chunked jobs.
- Stakes results are shown once the proposal confirms (seconds after the tally) with "Final at 11:03pm". Stakes stats, streaks, boards and `payout_claimable` wait until the result is final. If the guardian vetoes, clients get `refunded` and cards are re-rendered as refunded.
- Clients that load the page after a reveal fetch `/rounds/:id` and play the same animation once per round (tracked locally).
- Reveal animation: the two bars start equal, then grow to their headcount shares over 3 seconds. The winning bar lights up, and then the player's personal result card slides in: Unflocked plus the amount, or Got flocked with the sheep animation. Motion details are in Design\_Language.md.
- The next round is already open during the reveal, so the reveal screen ends with "The next question is already live", not a countdown.

## Question pipeline

Players write the questions: submit → automated moderation → community vote → admin approval → scheduled. The author of a used question earns the creator fee (Stakes) or creator award (Free) and creators leaderboard credit.

1. **Submit.** Signed-in users submit up to 3 questions per day. The client validates the format rules from Core game rules; the server validates again.
2. **Automated moderation** (synchronous, in the submit request). Call Claude Sonnet 5.5 (`claude-sonnet-5-5`) through the Anthropic TypeScript SDK. The fixed rubric sits in a cached system prompt, effort is low, and structured outputs (`output_config.format`) return this JSON:
   - `safe`: no slurs, sexual content, self-harm, harassment, real private individuals, or targeted political content about named living politicians.
   - `twoSided`: a reasonable person could pick either option; neither option is objectively correct.
   - `preferenceBased`: not a factual or trivia question.
   - `predictedSplit`: the model's guess of the larger option's share of people (0.5–1.0).
   - `duplicateOf`: id of a near-duplicate from the last 365 days, found by embedding similarity ≥ 0.9 (Workers AI embeddings + Vectorize).
   - Reject if not safe, not twoSided, not preferenceBased, or duplicate. Return the reason to the user. Store the full JSON in `moderation_json`.
   - If the model declines to answer (`stop_reason: refusal`) or the call fails, the question goes to admin review instead of being rejected automatically.
3. **Vote.** Passing questions enter the queue. Score = upvotes − downvotes with a time decay (half-life 3 days). The queue page shows the top 50.
4. **Approve.** An admin reviews the top-scored items in the console and schedules one per future day. A question with `predictedSplit` > 0.75 shows a warning.
5. **Run and credit.** After the round, compute `splitQuality = 1 − (maxShare − 0.5) / 0.5`, where maxShare is the larger option's headcount share. 1.0 = perfectly even. This drives the creators leaderboard.

**House questions**

- An admin-managed backlog of at least 14 house questions (author null) keeps the schedule full. If no question is scheduled at question lock, the scheduler picks the top house question and alerts the admin.

## Client app

One responsive web app (React + Vite + TypeScript) serves both the browser and the Farcaster/Base mini app. It is designed mobile-first, with a 380 px minimum width. The mini app context is detected via the Farcaster mini app SDK, which adjusts auth and sharing. All visual design follows [Design_Language.md](Design_Language.md).

| Screen | Route | Contents |
| --- | --- | --- |
| Today | `/` | Question, two option cards, stake selector (Free: presets + slider; Stakes: the round's fixed stake), mode toggle (Free/Stakes; Stakes hidden if ineligible), countdown to close, live entrant count and pool, crowd-history hint, primary CTA "Seal my pick" |
| Sealed | `/` (state) | Locked pick with a padlock, stake, countdown to the reveal, "Remind me" (notifications), invite friends |
| Reveal | `/` (state) | Unsealing countdown, reveal animation, personal result (Stakes: "Final at" time), share card preview, Share button, "The next question is already live" |
| Round detail | `/r/:id` | Settled split for both modes, winners count, top question comments (none in scope; link to Farcaster cast), verify link |
| Archive | `/archive` | Past rounds, newest first, with splits |
| Verify | `/r/:id/verify` | Manifest, chunk hashes, Merkle roots, drand round and verified signature, onchain transaction links. "Verify my entry" decrypts the user's own entry in the browser and checks it against its receipt and the anchored root (Free) or its `Entered` event (Stakes), its chunk and the totals. Full re-verification uses `npx @flocked/verify` |
| Profile | `/u/:handle` | Avatar, handle, stats per mode, streaks, recent results, authored questions |
| Leaderboards | `/leaderboards` | Tabs: Strays today, Streaks, Weekly, Creators; mode filter |
| Submit | `/submit` | Question form with live format validation; result of moderation |
| Queue | `/queue` | Voting list with up/down arrows |
| Rooms | `/rooms`, `/rooms/:id` | Create, invite link, room round, room points, room leaderboard |
| Claims | `/claims` | Unclaimed Stakes payouts and refunds, claim-open times, "Claim all" |
| Settings | `/settings` | Linked identities and pending merges, Coinbase verification, creator payout wallet, card and profile privacy, notifications, stake cap, self-exclusion, sign out |
| Onboarding | modal | Three-card explainer: "Pick the side fewer people pick", "Picks stay sealed until just after 9pm ET", "The Flock loses. Strays win." Then sign-in |

**Entry flow (Free)**

1. Tap an option → choose stake → tap "Seal my pick".
2. The client checks the target round and its lock leaf, encrypts with tlock, and POSTs `{stake, ciphertext}`. It verifies the returned receipt (signer and every field) and stores the plaintext pick and receipt locally.
3. On success, transition to Sealed. On 4xx, show the error and keep the selection.

**Entry flow (Stakes)**

1. Same option UI with the round's fixed stake shown. Eligibility (verified Coinbase sign-in, geo, age, ToS, limits) has already been checked via `/me`. Unverified users are sent to "Verify with Coinbase"; inside the mini app this opens an external browser, and the app polls `/me` until verification completes.
2. The client runs the round config check (see Sealed picks), encrypts, and requests a ticket from `/entries/stakes/prepare`. It then builds and sends a single sponsored user operation (approve or permit + `enter` with the ticket) through the smart wallet.
3. Show pending until the transaction is included. The RoundDO counter updates when the indexer sees `Entered`.

## Share cards and distribution

Every player gets a personal result card the moment their mode reveals, and sharing is one tap. The card is the main growth surface. Card visuals follow Design\_Language.md.

**Card content** (three PNG variants: 1200×630 for OG, 1200×800 (3:2) for Farcaster mini app embeds, 1080×1080 square for stories)

- Question text and the split as horizontal bars, with percentages by headcount.
- The player's pick highlighted.
- Big result line: "UNFLOCKED +12.40 USDC" / "UNFLOCKED +86 pts" / "GOT FLOCKED", with sheep art.
- Stray streak if ≥ 2. Handle and avatar. Wordmark and URL.
- Stakes amounts are shown only if the user enabled "show amounts on cards" (default off). Otherwise the card shows the multiple, e.g., "2.6x".

**Generation**

- Cards are rendered in the settlement fan-out (a Queue consumer) with satori + resvg-wasm in a Worker. They are stored in R2 at `cards/{roundId}/{mode}/{userId}/{kind}/{variant}.png` and cached at the edge. After a veto, cards are re-rendered at the same keys and the edge cache purged.
- Also a generic round card (split only, no player) for `/r/:id`, stored at `cards/{roundId}/{mode}/round/{variant}.png`.
- Target: all cards for a round rendered within 5 minutes of the reveal. A player's own card is rendered on demand if missing.

**Share surfaces**

- `/s/:shareId` serves OG tags and Farcaster mini app embed meta, so a cast shows the card with a "Play today's Flocked" button. Share IDs are opaque and stable: changing or freeing a handle never breaks or redirects an old link.
- Share sheet: Farcaster cast composer (in mini app), native Web Share API, copy link, download image.
- Pre-filled share text varies by result: "got flocked again" / "unflocked, 3 day stray streak" + link.
- A pre-reveal share: "I sealed my pick. Can you out-think the flock?" with a teaser card that shows the question but not the pick. The teaser is a `share_cards` row with kind = teaser and its own share ID; it never reads the pick, and its page links to the round after the reveal.

**Distribution hooks**

- Daily cast from the official account at `opensAt` with the question as a mini app embed.
- **Referral:**
  - The invite link adds `?ref=<ref_code>`, a stable random code per user (not the handle). Visiting `/s/:shareId` attributes to the card owner's code. The attribution is kept for 7 days and carried into signup.
  - A referral qualifies when the invitee's first valid Free entry in a daily round settles. Room rounds never qualify.
  - Both users then get 100 global points, subject to the anti-farming rules.

## Profiles, leaderboards and rooms

Social features give players something to protect (streaks) and someone to beat (friends). Global stats and boards are computed from daily-round `user_stats` and `settlements` after each settlement (Stakes: once final). Room rounds never count toward them.

**Profiles**

- Public by default: handle, avatar, rounds played, win rate, current and best stray streak, play streak, authored questions with split quality.
- Stakes net result is private unless the user opts in.

**Game day and streaks**

- A round's game day is the New York date on which it closes. A round running Monday 21:00 to Tuesday 21:00 counts as Tuesday.
- Streaks count consecutive game days.
  - Refunded and voided game days are neutral for the stray streak: they neither break nor extend it.
  - A refunded entry still counts as played for the play streak.
- The daily stake cap applies per game day. Weekly boards use the ISO week (Monday to Sunday) of the game day.

**Leaderboards**

| Board | Ranking | Period | Tie-break |
| --- | --- | --- | --- |
| Strays | Today's winners, by current stray streak | Daily | Best stray streak, then earlier entry time |
| Streaks | Current stray streak | Live | Best streak, then rounds played |
| Weekly | Wins in the ISO week of the game day | Weekly | Net result |
| Creators | Mean split quality of used questions (min 2 questions) | All time | Number of used questions |

- Each board has a mode filter.
- Global boards (Free and Stakes) list only verified users. Every Free entry still counts in Free tallies; unverified users simply don't appear on boards. Merged-away accounts never appear.

**Rooms** (private groups)

- Any user creates a room (max 50 members by default) and shares an invite link.
- A room either mirrors the daily question or runs a custom question set by the owner, using the same moderation step. "Mirror" means the same question and schedule as the daily round. A room entry is separate from the daily entry and produces its own sealed tally among members, and a member can pick differently in each.
- Room rounds use the daily schedule and the same RoundDO class (one DO per room round). Each is its own `rounds` row with kind = room. It has a single Free `round_modes` row unless Stakes rooms are enabled. Only members can enter or view a room round.
- **Room points.** Free room rounds stake room points, not global points.
  - Each member has a separate per-room balance (`point_balances` scope = room id).
  - 500 room points on joining (the owner gets them at room creation), plus +100 per room round, credited on the member's first visit or entry after the round opens, if the room balance is below 1,000.
  - The same atomic rules apply.
- **Anti-farming:**
  - Room rounds never count toward global stats, streaks, leaderboards or referrals.
  - A room round refunds unless it has at least 3 qualifying entrants: valid entries from distinct users whose accounts were at least 24 hours old at `closesAt`. Distinct users are distinct people where verified, because a person ID binds to only one account. The API decides which entries qualify and passes that flag to settlement, which counts only qualifying entries for rule 1.
  - For Stakes room rounds, tickets go only to members whose accounts meet the age rule, and `minEntrants` = 3 onchain, so every onchain entry qualifies.
  - Qualification is recorded per entry in the (members-only) bundle.
  - An unverified person with several accounts can still meet the minimum alone. That is accepted, because the only reward is room points.
  - Stakes rooms stay behind flag `rooms.stakes.enabled` (off by default) and require verified users plus the usual geo and age checks.
- The room page shows the room split, member picks after the reveal, and a room leaderboard (room points, wins this week, streaks).

## Notifications

Three moments matter: the question drops, the round is about to close, and the reveal. Everything else is opt-in.

| Event | Default | Timing | Channels |
| --- | --- | --- | --- |
| `question_live` | On | At `opensAt`, only to users who entered no round that just closed | Farcaster mini app notification, web push |
| `closing_soon` | On, only if not yet entered | 60 min before `closesAt` | Farcaster, web push |
| `outcome` | On, only if entered | At the user's first mode outcome at the reveal, whether it revealed or was refunded. One combined message: their result plus "the next question is live". Other modes' and room rounds' results appear in the app only | Farcaster, web push, email (if verified) |
| `payout_claimable` | On (Stakes) | When the result is final and claims open (2 h after the proposal) | Web push, email |
| `refunded` | On, only if entered | For later events only: a veto, a Stakes refund becoming final, or a rule-7/8 refund after the outcome was sent | Farcaster, web push, email |
| `question_used` | On | When the user's question is scheduled and when it settles | Farcaster, web push |
| `streak_at_risk` | Off | 3 hours before close, if stray streak ≥ 3 and not entered | Farcaster, web push |
| `question_edited` | On | When an admin edits the wording of the user's question | Farcaster, web push |
| `security_notice` | Always on | New email sign-in, identity linked, merge pending or completed | Every available channel, including a newly linked email |

- Sends go through a Queue (`notify`) with dedupe keys:
  - `outcome:{gameDay}:{userId}`;
  - `refunded:{roundId}:{mode}:{userId}` and `payout_claimable:{roundId}:{mode}:{userId}`;
  - `question_used:{questionId}:{scheduled|settled}`, `question_edited:{auditId}`, `security_notice:{noticeId}`;
  - `{event}:{roundId}:{userId}` for the rest.
- Respect Farcaster notification token rate limits; batch where the API allows.
- Self-excluded users receive no game notifications.

## Admin console

A protected section of the same app at `/admin`, available only to users with `role = admin` and guarded additionally by Cloudflare Access. Every action writes to `audit_log`.

- **Schedule:** a calendar of upcoming daily rounds. Assign a question to a day, and edit round config (stake, fees, cap, minEntrants) until question lock.
- **Question queue:** top-scored submissions with moderation JSON and predicted split. Approve, reject with a reason, edit wording (author notified), or add house questions.
- **Live round:** status per mode, counters, DO health, indexer lag, anchor status, safe-head lag, settlement progress.
- **Interventions:**
  - Void a round, only before `closesAt`; this refunds every mode.
  - Retry settlement.
  - Pause the contract, which blocks new entries only.

  Admins cannot void after close. After close:
  - a Stakes mode is refunded only through a refund proposal under rules 1–3 (challengeable), `refundTooFew`, the 72-hour timeout, or a guardian veto of a settlement;
  - a Free mode is refunded only automatically under rules 1–3, 7 or 8.

  The watcher checks every case.
- **Challenge window:** every Stakes proposal inside its window, with the watcher's verdict. The veto itself is signed by the guardian multisig outside the console.
- **Users:** search; suspend or unsuspend; view identities, merges, entries and ledger; change role; manual points adjustment with a required reason.
- **Flags and config:** feature flags, geo allow/deny lists, fee defaults, notification copy.

## Compliance and responsible play

Stakes mode is likely to be treated as gambling in many jurisdictions. It is geo-fenced to an allow list and must not be enabled in production without legal sign-off. Free mode has no cash value and is available everywhere.

**Launch.** Free and Stakes launch together. Stakes opens on day one in the jurisdictions counsel has signed off, and the production launch waits for that sign-off. If the Coinbase personhood check cannot be confirmed (see Launch gates), Free launches on schedule and Stakes waits.

**Sanctions.** There is no sanctions screening at launch, per legal review on Oct 7, 2026. Revisit before adding jurisdictions.

**Geo-fencing**

- Eligibility needs all of these in `geo.stakes.allow` (default empty, so Stakes is unavailable until configured):
  - the user's Coinbase Verified Country, which must match the country of the same OAuth account;
  - the request location (`request.cf.country`, `request.cf.regionCode` for region-level rules).
- Checked on `/me`, at every ticket issue, and in the claims UI. Ineligible users see Free mode only and no Stakes UI. Claims and refunds of already-entered rounds are always available.
- VPN/proxy signals from Cloudflare (bot management score and known-proxy flags where available) block ticket issue.
- Enforcement is onchain through entry tickets. `enter()` rejects any entry without a valid ticket, so calling the contract directly cannot bypass geo, age, self-exclusion or caps, as long as the ticket signer is uncompromised. Settlement checks every entry against the issued-ticket records.

**Age and terms**

- Stakes mode requires an 18+ attestation (21+ where the allow-listed jurisdiction requires it, configured per region) and ToS acceptance, stored with timestamp and ToS version.
- Stakes always requires a verified user (`kyc_status = verified` from Coinbase personal details). There is no flag to turn this off.

**Responsible play**

- Daily stake cap per user (default 100 USDC per game day). The user can lower it anytime and raise it after a 24-hour delay. It is enforced at ticket issue.
- Self-exclusion: 7 days, 30 days, 6 months, or permanent. It blocks all entries in both modes (no tickets, no Free entries) and all game notifications. A self-excluded account cannot be merged.
  - A timed exclusion can't be ended early.
  - A permanent exclusion can be lifted only on request after 6 months, and the lift takes effect after a 7-day cooling-off period.
- The Stakes UI always shows the user's net result for the last 30 days.
- A persistent link to responsible gambling resources appears in Settings and in the Stakes onboarding.

## Anti-abuse

In Stakes, headcount, personhood and a fixed stake together decide the outcome: each verified person gets one entry per round at the same stake, however many wallets they control. Anti-abuse work focuses on points farming, bots and spam.

- **Turnstile** on sign-up, question submission and the first Free entry of each game day.
- **Points farming:** the daily grant and referral bonus require an account at least 24 hours old with a linked Farcaster account or a wallet that has at least one prior onchain transaction. The referral bonus is capped at 10 per referrer per week.
- **Free-mode extra accounts:** extra Free accounts can add heads to a Free tally and tilt which side wins. That can boost a verified account's wins and streaks on global boards, even though the extra accounts never appear there. This is accepted residual risk because points have no value. Analytics flag board leaders whose wins line up with clusters of new or unverified entrants on the opposite side (recent signups, shared IP ranges).
- **Entry timing:** the RoundDO accepts Free entries only before `closesAt` by its own clock; Stakes entries rely on block timestamp. Entries in the last seconds are allowed. Nothing about the split is knowable until the beacon, at least 60 seconds after the last possible entry. For Stakes this assumes Base is producing blocks at close (see Residual risk).
- **Coordination in Stakes:**
  - Every entry has the same stake, so a group gains nothing by buying heads on one side and putting money on the other.
  - Friends who agree to pick opposite sides only reduce their variance; their combined expected value is close to that of picking at random. That is accepted residual risk.
  - One person cannot cover both sides, because entries are per person.
- **Copied picks:** anyone can copy a public Stakes ciphertext and blindly mirror another player's pick. This is accepted (decided Oct 7): the copier doesn't learn the pick, and the copy just adds a head to the same side.
- **Spam questions:** submission rate limits and moderation. After 5 rejected submissions in 7 days, question submission is blocked for 7 days; play is unaffected.
- **Operator honesty:**
  - Parameters are frozen onchain at question lock.
  - Admins cannot void after close.
  - Free rounds commit their beacon round at lock and their entry set before the beacon, write-once.
  - Every outcome is a proposal checked against a posted tally, re-verified by an independent watcher, and open to a guardian veto before it becomes final.

## Analytics

Events go to Workers Analytics Engine (server-side for authoritative events, client beacon for UI events) and power one internal dashboard. Never log plaintext picks before reveal.

| Event | Source | Key properties |
| --- | --- | --- |
| `page_view` | client | route, ref, miniApp (bool) |
| `signup` | server | method (siwe, farcaster), ref |
| `entry_submitted` | server | mode, stake, secondsBeforeClose, firstEver (bool) |
| `reveal_viewed` | client | mode, result, secondsAfterReveal |
| `share_clicked` | client | surface (cast, native, copy, download), result |
| `share_landing` | server | roundId, shareId |
| `share_conversion` | server | roundId, shareId (sent on the account's first-ever entry within 7 days of arriving through a share link) |
| `question_submitted` | server | passed (bool), rejectReason |
| `question_voted` | server | value |
| `personhood_verified` | server | merged (bool) |
| `claim_completed` | server | amount, rounds |
| `notification_sent` / `notification_opened` | server / client | event, channel |

**Dashboard metrics:**

- daily entrants by mode, D1/D7/D30 retention;
- share rate (sharers ÷ entrants), share→entry conversion;
- split quality per day, question submissions per day;
- verification rate, Stakes volume and fees;
- time from beacon to reveal, safe-head lag at close.

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Scale | 100,000 entries per round per mode without degradation; 50,000 concurrent WebSocket clients on the reveal |
| Latency | Free entry p95 < 400 ms end to end, committed before acknowledgement; `/rounds/today` p95 < 100 ms from cache |
| Reveal | Beacon at `closesAt` + 2 min. Each mode reveals p95 < 2 min after the beacon at full scale (Stakes: after the later of the beacon and the safe head passing the close block). Rounds under about 5,000 entries reveal within seconds |
| Settlement | Free commitments anchored before beacon time. Stakes proposal confirmed within 10 min of the beacon; final and claimable 2 h later |
| Availability | 99.9% for read paths during the 30 min around the reveal |
| Correctness | The payout invariant holds for every settlement; settlement is idempotent (re-running yields identical output and no double writes) |
| Security | Separate keys for operator, ticket signer, receipt signer and anchor, held in Workers Secrets or a managed signer, with the ticket signer isolated in its own Worker. Guardian is a separate multisig. Admin behind Cloudflare Access. Contracts audited before mainnet with funds |
| Privacy | Plaintext picks never logged or stored server-side before the beacon. Per-round person tags onchain. Raw Coinbase IDs, names and addresses never stored. IPs kept only within rate-limit windows |
| Accessibility | WCAG 2.1 AA; reveal animation respects `prefers-reduced-motion` |
| Observability | Structured logs and alerts (see below) |

**Alerts** fire on any of these:

- settlement failure or reconciliation mismatch;
- a Free commitment not confirmed by its deadline, min(close + 90 s, beaconTime − 30 s);
- safe head not past the close block by beacon time + 60 s;
- indexer lag over 150 s;
- an anomalous VOID rate;
- DO errors or a schedule gap;
- a watcher mismatch or a missing verdict;
- any `FlockedEscrow` or `FlockedAnchor` event the backend didn't send.

**Scaling notes**

- **Decryption fan-out.**
  - One tlock decryption costs one BLS12-381 pairing plus a G2 multiplication, measured at about 10–18 ms per ciphertext. At 100,000 entries that is roughly 1,000–1,800 CPU-seconds per mode.
  - The coordinator writes chunks of about 500 ciphertexts to R2 and sends one queue message per chunk. Stakes chunks are prepared between close and the beacon.
  - Decrypt consumers run with the Queue settings in Architecture, with daily and room rounds on separate queues. Queues scale consumers up gradually.
  - A cold-start load test at 100,000 entries per mode, for both modes at once, is a launch requirement. If it misses the reveal target, the fan-out design goes back to the owner rather than the target quietly slipping.
- **WebSocket fan-out.** One RoundDO per round can become a hotspot at 50k clients, so viewers are sharded across N `RoundViewerDO` instances (N = 16 default). The shards subscribe to the primary DO and relay broadcasts.
- **Bundles.** Bundles are chunked so the browser fetches only the user's chunk and the manifest.

## Testing and acceptance criteria

The settlement engine is the riskiest code. It is a pure, shared TypeScript package (`@flocked/settle`) with exhaustive tests, used by the Worker, the Verify page, `@flocked/verify` and the contract tests (through recorded vectors that must match the contract's closed form).

**Required tests**

- Settlement unit tests:
  - every refund rule and headcount ties;
  - cap binding and not binding, and rebates to losers;
  - a headcount minority holding more stake than the majority (Free);
  - VOID entries of each kind, including non-canonical headers, wrong target round, wrong chain, `not_anchored` and out-of-range Free stakes;
  - single-base-unit stakes;
  - the largest Stakes values in `bigint`.
- Property tests (fast-check) on random rounds:
  - the invariant always holds and no payout is negative;
  - every winner's payout is between s and (1 + cap)·s, and every loser's between 0 and s;
  - dust is below the losing headcount;
  - results are independent of entry order;
  - the Stakes closed form equals the general formula.
- Contract tests (Foundry):
  - all reverts, including every `createRound` validation and launch ceiling;
  - ticket signature, wallet binding, expiry and per-person dedupe;
  - `voidRound` only before close; `refundTooFew` only when `entryCount < minEntrants`;
  - `propose` tally checks and derived amounts;
  - the challenge window, veto in both directions, and `finalize`;
  - per-kind claim limits; `withdraw` with a creator that cannot receive USDC;
  - `refundTimeout`, pause behaviour, role timelocks;
  - no path that both settles and refunds a round;
  - `FlockedAnchor` write-once rules, the deadline relative to the beacon, and skip-and-emit for invalid batch items;
  - an entry ticket signed for one escrow reverts on another.

  Also fuzz `enter`, `propose` and `claim`, and run an invariant test that USDC held ≥ the sum of every round's outstanding obligations.
- tlock tests:
  - encrypt in the browser bundle, decrypt in the Worker with a recorded drand signature;
  - a corrupted signature is rejected before decryption;
  - malformed, extra-stanza, wrong-round and wrong-chain ciphertexts become VOID, as do plaintexts with the wrong length, version or round reference;
  - client-side target-round checks match the contract.
- RoundDO tests:
  - entry after close rejected; duplicate entry rejected;
  - missing or insufficient balance rejected atomically; non-member room entry rejected;
  - receipts verify against the root; no acknowledged entry is missing from the root at a close-boundary race;
  - out-of-range stake, suspended and self-excluded entries rejected;
  - alarm chain; reconnect snapshot.
- Identity and auth tests:
  - linking; pending merges and confirmation; merge refusals (unsettled entries, different person IDs, restrictions);
  - one person ID per user;
  - login-CSRF on the OAuth callback;
  - email-code brute force and replay; the mini-app Bearer flow;
  - `/prepare` eligibility: geo, age, ToS, self-exclusion, cap with live tickets, the kill switch, one live ticket per person.
- Pipeline tests:
  - reveal gating across API, WebSocket, cards and bundles, plus a log scan for plaintext picks;
  - AnchorDO per-key deadlines and partial batch failure;
  - indexer reorg replay;
  - deterministic manifests: two runs give byte-identical output;
  - the watcher's match and mismatch verdicts, and its dead-man's switch;
  - the verify CLI against end-to-end bundles.
- End to end (Playwright) on a local stack: wrangler dev, an anvil fork of Base, and a local drand network (drand's Docker image). The local network's chain constants are injected into `packages/tlock` and the contracts' constructors:
  - sign in, verify personhood, enter Free, enter Stakes;
  - close, beacon, reveal;
  - share card exists;
  - claim after the challenge window;
  - a settlement veto turns into refunds in the UI;
  - a vetoed refund proposal is followed by a settlement;
  - a submitted question flows through to creator credit;
  - each entrant gets exactly one outcome notification per game day, and `question_live` reaches only non-entrants;
  - a timed exclusion can't be shortened, and a permanent exclusion lifts only 7 days after a request made 6 months in;
  - two Stakes entries with identical ciphertexts both count;
  - the paymaster accepts approve-plus-enter in one user operation, rejects other calls, and enforces the daily cap;
  - `DELETE /me` anonymizes the account and its cards, is refused during an exclusion, and leaves wallet-only claims working;
  - 5 rejected questions in 7 days block submission for 7 days without affecting play;
  - a Free round refunds when the local drand network is held down past 24 hours (simulated clock).

**Acceptance criteria**

- [ ] A daily round opens, accepts Free and Stakes entries, closes, settles and reveals automatically, with no manual step.
- [ ] No per-option information is retrievable through any API, log or storage before the beacon, and no endpoint shows a mode's split before that mode's reveal.
- [ ] Anyone can reproduce every settlement and Merkle root exactly with `npx @flocked/verify` from chain data, drand and the bundle. Any player can verify their own entry in the browser.
- [ ] Every onchain Stakes entry carries a valid ticket, one person cannot enter a round twice from different wallets, and every VOID can be recomputed from public data.
- [ ] Stakes payouts:
  - winners can claim exactly the computed amount after the challenge window, and losers only their rebate;
  - a guardian veto of a settlement results in a full refund;
  - funds are refundable if the operator never proposes;
  - no round can be both settled and refunded;
  - claims cannot exceed a round's derived totals.
- [ ] Every Free round that is locked and not voided before close has exactly one lock leaf and one commitment onchain. In normal operation the commitment lands before the beacon; rule 7 is the backstop. Every Free receipt verifies against that commitment.
- [ ] Every settled player has a share card, and the share URL unfurls correctly on Farcaster and standard OG consumers.
- [ ] Stakes UI is absent for users who are not verified, are outside the geo allow list, are under the age requirement, or are self-excluded.
- [ ] A submitted question flows through moderation, voting, approval and scheduling, and its author receives the creator fee or award after settlement.

## Out of scope, launch gates and decision log

**Out of scope**

- Native iOS/Android apps (the web app and mini app cover mobile).
- Fiat on-ramp and card payments.
- In-app comments or chat (discussion happens on Farcaster).
- Tokens, NFTs of results, or any transferable points.
- Questions with three or four options. When they return, they need a new contract and settlement version where each option needs a minimum number of entrants to count, so a tiny entry on an unpicked option cannot win by default.
- A bonus pot or any rollover between rounds.
- Variable stakes in Stakes mode.
- Sanctions screening (per legal review; revisit before adding jurisdictions).
- Live intra-round hints about the split. These are impossible by design under timelock encryption.

**Launch gates** (all required before production launch. If gate 2 slips, Free launches on schedule and Stakes waits; gates 1, 3 and 4 block the whole launch)

1. **Legal sign-off.** Counsel names the first jurisdictions for `geo.stakes.allow` and confirms the skill-contest vs. wager position there.
2. **Coinbase personhood.** Confirm with Coinbase that `GET /v2/user/personal-details` returns data only for ID-verified accounts. If it doesn't, Stakes waits and Free launches on schedule.
3. **Contract audit.** `FlockedEscrow` and `FlockedAnchor` audited before mainnet funds.
4. **Load test.** The cold-start decryption test at 100,000 entries per mode for both modes meets the reveal target. Otherwise the design goes back to the owner.

**Decision log**

| Date | Decision |
| --- | --- |
| Oct 7, 2026 | Minority decided by headcount; payouts within the winning side proportional to stake |
| Oct 7, 2026 | One verified person, one Stakes entry, via entry tickets; person ID from Coinbase sign-in, verified through the same Coinbase account |
| Oct 7, 2026 | Two options only at launch; no bonus pot; cap excess returned to losers |
| Oct 7, 2026 | Fixed stake per Stakes round, default 5 USDC; Free keeps a 10–100 point range |
| Oct 7, 2026 | Payout cap raised to 10x |
| Oct 7, 2026 | Fees stay on the whole loss pool, even when the cap returns most of it |
| Oct 7, 2026 | Free and Stakes launch together, gated as above |
| Oct 7, 2026 | Daily close stays 21:00 America/New\_York; rooms use the same time at launch |
| Oct 7, 2026 | Moderation runs on Claude Sonnet 5.5 |
| Oct 7, 2026 | Strays board ranks today's winners by current stray streak |
| Oct 7, 2026 | Entrants get one combined notification at the reveal |
| Oct 7, 2026 | Self-exclusion is locked for its term; permanent exclusions lift only on request after 6 months, with a 7-day cooling-off |
| Oct 7, 2026 | Accepted risks: Base halts longer than the beacon delay; copied Stakes ciphertexts; Free extra accounts tilting outcomes (monitored) |
| Oct 7, 2026 | No sanctions screening at launch (legal) |
| Oct 7, 2026 | If Coinbase can't confirm personhood, Stakes is delayed and Free launches |
| Oct 7, 2026 | Engineering defaults adopted: fixed-length plaintext; OpenZeppelin Merkle trees; Free rule-8 refund after a 24-hour drand outage; local drand for tests; opaque share links with a 3:2 embed image; D1 ciphertext archival; separate share-conversion event; paymaster limits; a 7-day question-submission block instead of suspension; account deletion by anonymization |
| Oct 7, 2026 | Follow-on defaults (change if you disagree): room results notify in the app only; the story card stays 1080×1080 square; deleting an account keeps a person tombstone so caps carry over; invite links use a random `ref_code` instead of the handle |
| Oct 7, 2026 | EIP-712 ticket and receipt domains use the deployment chain's ID (8453 in production, 84532 for Base Sepolia staging) instead of a fixed 8453, so staging runs on Base Sepolia. The contracts take it from `block.chainid` |
| Oct 7, 2026 | Only the admin multisig can unpause `FlockedEscrow`. `PAUSER_ROLE` can only pause, so a stolen pauser key can't undo a pause |
| Oct 7, 2026 | No `withdrawTo`: `withdraw` pays only the credited address. A credited address on Circle's blocklist stays credited until it's unblocked, because letting it send funds elsewhere would get around the blocklist |
| Oct 7, 2026 | Wave-1 contract and settlement behaviour written into the spec as built: `createRound` rejects beacon round 0; `enter` rejects a zero `personTag` and checks the USDC received; `propose` rejects a zero `bundleHash`, and a zero `payoutRoot` on settle proposals; refund rules are checked in order 1, 2, 3; after a veto every entrant (VOID included) reclaims their stake and no fees are credited; vetoed proposals stay readable as evidence; only the admin executes or cancels timelocked changes, which don't expire; one entry per account per round; `minEntrants` and `capMultiple` are at least 1; refunded rounds pay no creator fee or creator award; the API decides room qualification |
| Oct 7, 2026 | `GUARDIAN_ROLE` has exactly one holder. The guardian hands the role on with `transferGuardian` (immediately), and the admin's 7-day replacement is a single write, so a stolen guardian key can't block its own replacement by granting the role to many addresses |
| Oct 7, 2026 | The win and loss voice lines in Design\_Language.md (Voice) are templates: whole percent, with the winning share rounded down and the losing share rounded up, so a winner never reads 50%; "<1%" and ">99%" at the extremes |
