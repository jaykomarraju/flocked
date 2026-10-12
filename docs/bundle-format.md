# Verification bundle format

The public output of one mode's settlement (spec "Settlement and payout math" › Settlement output). The
settlement coordinator (`apps/api/src/settlement/`) writes it; `@flocked/verify` (W9-B), the watcher and the
Verify page read it. This document pins the format: a change bumps `bundleFormat` and is a Z decision.

- **Bundle format:** `bundleFormat` = **1**.
- **Formula version:** `formulaVersion` = **1** (`FORMULA_VERSION` in `@flocked/settle`).
- TypeScript shapes: `apps/api/src/settlement/types.ts` (`Manifest`, `ChunkRef`, `BundleChunk`, `BundleEntry`).

## Objects and keys

All objects live in the R2 bucket (`BUCKET`), one prefix per (round, mode):

| Key                                         | Object                                          |
| ------------------------------------------- | ----------------------------------------------- |
| `bundles/{roundId}/{mode}/manifest.json`    | The manifest. Written last.                     |
| `bundles/{roundId}/{mode}/chunk-{nnnn}.json` | Entry chunk `nnnn` (zero-padded to 4 digits, from `0000`). |

`roundId` is the round's ULID; `mode` is `free` or `stakes`. A mode with no entries has a manifest and no chunks.

**Write-once.** A bundle object is never replaced. A retry that produces the same bytes leaves the object as
it is; different bytes at an existing key fail the settlement and page (`ALERT_SETTLEMENT_FAILED`). Objects
are served `Cache-Control: public, max-age=31536000, immutable`. A bundle is complete once its manifest exists.

## Encoding

- Every object is the UTF-8 bytes of the **RFC 8785 (JCS) canonical JSON** of its value (`canonicalJson` in
  `@flocked/shared`): object keys sorted by UTF-16 code units, no whitespace, numbers in ECMAScript form.
- Integers that can exceed 2^53 (stakes, amounts, tallies, the onchain round ID) are **decimal strings**.
  Counts, `seq`, indexes, `beaconRound` and Unix-second times are JSON numbers.
- Hex (hashes, roots, nonces, signatures with `0x`, addresses) is lowercase. The drand signature and chain
  hash are lowercase hex without `0x`, as drand serves them.
- Optional fields are omitted, never `undefined`; `null` means "none".
- Hashes are `keccak256` of the object's exact bytes:
  - a chunk's `hash` = keccak256(chunk bytes);
  - **`bundleHash` = keccak256(manifest bytes)**. It is posted in the Stakes proposal and anchored write-once
    through `FlockedAnchor.anchorManifest` for Free.

The manifest is a deterministic function of chain data, the drand round and the settlement inputs. It holds no
time of settlement and no relay identity (the relay that served the beacon is only logged), so every run and
every retry gives byte-identical objects (PIPE-4).

## Entry order and chunks

Entries are ordered by **`seq`**:

- Free: `receipt_seq`, which is contiguous from 0 (the receipt's `seq`).
- Stakes: the position of the entry's `Entered` event in (block number, log index) order, from 0.

Chunk `i` holds exactly the entries with `i × chunkSize ≤ seq < (i + 1) × chunkSize`, in seq order.
`chunkSize` is in the manifest (**5,000** in production). Decryption runs in separate, private batches of 500
(below); they don't affect the bundle's bytes.

## Manifest

| Field            | Type                         | Meaning                                                                                                  |
| ---------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `bundleFormat`   | number                       | 1                                                                                                        |
| `formulaVersion` | number                       | 1                                                                                                        |
| `roundId`        | string                       | ULID                                                                                                     |
| `mode`           | `"free"` \| `"stakes"`        |                                                                                                          |
| `kind`           | `"daily"` \| `"room"`         |                                                                                                          |
| `roomId`         | string \| null                | Room rounds                                                                                              |
| `closesAt`       | number                       | Unix seconds                                                                                             |
| `beaconRound`    | number                       | The drand round every pick targets                                                                       |
| `config`         | object                       | The round's locked config (`rounds.config_json`, `LockedConfigSchema`), both modes' sections            |
| `drand`          | `{chainHash, signature}`      | The chain hash and the signature for `beaconRound`, verified against the pinned public key              |
| `commitment`     | `{root, anchorTx, entryCount}` \| null | Free: the anchored commitment root, the anchor transaction and its leaf count. null for Stakes and for a Free mode with no entries |
| `chainRoundId`   | string \| null                | Stakes: the FlockedEscrow round ID                                                                      |
| `closeBlock`     | `{number, hash}` \| null      | Stakes: the close block, the last block stamped before `closesAt` (final once the safe head passed it). Free: null |
| `record`         | object                       | The settlement record (below)                                                                            |
| `voids`          | object                       | VOID count per reason, only reasons that occur                                                           |
| `payoutRoot`     | hex \| null                   | The payout tree's root (below); null when it has no leaves                                               |
| `entryCount`     | number                       | Entries in the bundle (VOIDs included)                                                                   |
| `chunkSize`      | number                       | Entries per chunk                                                                                        |
| `chunks`         | array                        | One `ChunkRef` per chunk, by index                                                                       |

`record` is `@flocked/settle`'s `SettlementRecord` with bigints as decimal strings: `outcome` (`settled` \|
`refunded`), `refundReason` (1–3 or null), `n` and `w` (per option, valid entries only), `winner` (0, 1 or
null), `lossPool`, `fee`, `creatorFee`, `distributable`, `rebatePool`, `dust`, `voidCount`, `voidStake`,
`total`, `creatorAward` (Free; 0 when the config's `awardRecipient` is null).

A `ChunkRef` is `{index, key, hash, entries, firstSeq, lastSeq, totals, voids}`: `totals` is
`[{n, w}, {n, w}]` (headcount and stake per option over the chunk's valid entries, decimal strings) and `voids`
the chunk's VOID count.

## Chunk

`{bundleFormat, roundId, mode, index, entries}`, where each entry is:

| Field        | Type                 | Meaning                                                                                |
| ------------ | -------------------- | -------------------------------------------------------------------------------------- |
| `seq`        | number               | As above                                                                               |
| `account`    | string               | Free: `userIdHash` (bytes32 hex). Stakes: the lowercase wallet                         |
| `stake`      | string               | Points (Free) or USDC base units (Stakes)                                              |
| `option`     | 0 \| 1 \| null        | The decrypted option; null when VOID                                                   |
| `nonce`      | hex \| null           | The plaintext's 16-byte nonce; null when VOID                                          |
| `valid`      | boolean              | `option !== null`                                                                      |
| `voidReason` | string \| null        | One of `@flocked/settle`'s `VOID_REASONS`; null when valid                             |
| `commitment` | hex                  | Free only: keccak256(ciphertext), the receipt's commitment                             |
| `ciphertext` | string \| null        | Free only: the ciphertext, base64url (unpadded). Stakes ciphertexts are onchain        |
| `qualifies`  | boolean              | Room rounds only: counts toward the room minimum (not written yet; W8)                 |

The receipt fields of a Free entry are (`roundId`, mode 0, `account` = userIdHash, `stake`, `commitment`,
`seq`): exactly the commitment leaf. The receipt's EIP-712 signature is not stored server-side, so it is not
in the bundle; the player keeps it.

## VOID reasons and their order

A Free entry's reason is decided in this order, and the first that applies wins:

1. `not_anchored`: `seq ≥ commitment.entryCount` (outside the anchored leaf set);
2. `stake_out_of_range`: `stake` outside the locked `[stakeMin, stakeMax]`;
3. then `classify` (`@flocked/tlock`) with the verified signature: `non_canonical_header`, `wrong_target`,
   `decrypt_failed`, `bad_plaintext`, `bad_option` (spec "Sealed picks" › Invalid entries).

Entries with reason 1 or 2 are not decrypted (`option` and `nonce` null), but their ciphertexts are kept.
Stakes entries go straight to `classify`, with the round reference the onchain round ID.

## Verifying a bundle

1. Check each chunk's `hash`, and `bundleHash` against the onchain anchor (Free) or proposal (Stakes).
2. Verify `drand.signature` for `beaconRound` against the pinned chain (`@flocked/tlock` `verifyBeacon`).
3. Free: rebuild the commitment tree over the entries with `seq < commitment.entryCount` (leaves above,
   OpenZeppelin StandardMerkleTree) and compare with `commitment.root` and the anchored root.
4. Recompute each entry's reason and option (the order above), then `settle(entries, params)` with params
   from `config`: Free `{feeBps, creatorBps, capMultiple, minEntrants, creatorAwardBps}` (creatorAwardBps 0
   when `awardRecipient` is null); Stakes `{feeBps, creatorBps, capMultiple, minEntrants}`. Compare `record`.
5. Rebuild the payout tree from `settle`'s payouts and compare `payoutRoot`:
   - Free: `freePayoutTree(roundId, [(account, amount)])`, one leaf per payout (every account has at most one;
     zero rebates are omitted), any outcome;
   - Stakes, settled: `stakesPayoutTree(chainRoundId, [(account, kind)])`, kind win 0, rebate 1, void_refund 2;
     a refunded Stakes mode has no payout tree (`payoutRoot` null).

## Working files (not part of the bundle)

`settlement/{roundId}/{mode}/` holds one run's private working files: `beacon.json` (`{round, signature}`),
`in-{nnnn}.json` (a decrypt batch of 500: `{roundId, mode, index, beaconRound, roundRef, entries}`) and
`out-{nnnn}.json` (its per-entry results). Stakes also has `entered-{nnnn}.json`: the round's `Entered` logs
streamed from the chain up to the close block (at most 500 per file, `{roundId, index, entries}`, each entry
`{seq, txHash, logIndex, blockNumber, player, personTag, ticketHash, commitment}`), which settlement
reconciles against the contract and checks D1's entries against before decrypting. They are plain JSON, deterministic, rewritten by a retry, and never
served publicly. Their format may change without a `bundleFormat` bump.
