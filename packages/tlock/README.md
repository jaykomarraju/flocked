# @flocked/tlock

Timelock encryption for Flocked picks, on [`tlock-js`](https://github.com/drand/tlock-js) 0.9.0 and the drand
quicknet chain. It holds the pinned chain config, beacon math and the client's target-round check, the 34-byte
plaintext codec, encryption, strict header parsing, BLS beacon verification, decryption with a given signature,
and VOID classification. The same code runs in browsers, Node and the Workers runtime.

Spec: "Sealed picks (timelock encryption)" and "Round lifecycle" › Scheduling. Interface: P2.1 in
`docs/plan/wave-2.md`.

## API

| Export                                    | What it does                                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `DrandChain`, `QUICKNET`                  | Chain hash, public key, scheme, genesis and period. `src/chains.ts` is the only place chain constants live.                                   |
| `chainFromEnv(env)`                       | `DRAND_CHAIN_HASH`, `DRAND_PUBLIC_KEY`, `DRAND_GENESIS`, `DRAND_PERIOD`; all or none (`QUICKNET`). Throws on a partial or malformed override. |
| `MIN_BEACON_DELAY`, `MAX_BEACON_DELAY`    | 60 and 600 seconds, as in the contracts.                                                                                                      |
| `beaconTime(chain, round)`                | `genesis + (round − 1) × period`; throws for round < 1, like the contract.                                                                    |
| `firstRoundAtOrAfter(chain, t)`           | The first round whose time is ≥ `t`.                                                                                                          |
| `checkTargetRound(i)`                     | The client's refusal rules before encrypting (below). Returns `{ ok }` or a `TargetRoundError`.                                               |
| `isDailyClose(closesAt, gameDay)`         | `closesAt` is 21:00:00 America/New_York on `gameDay` (via `Intl`).                                                                            |
| `encodePlaintext`, `decodePlaintext`      | The 34-byte plaintext. `decode` returns null only for a wrong length.                                                                         |
| `roundRefFromUlid`, `roundRefFromChainId` | Free: the round ULID's 16 bytes. Stakes: the onchain round ID as a big-endian uint128.                                                        |
| `encryptPick(chain, round, pt)`           | Binary age ciphertext. Refuses anything but 34 bytes.                                                                                         |
| `isCanonicalHeader(ct, chain, round)`     | The header is canonical and targets exactly that round and chain.                                                                             |
| `verifyBeacon(chain, round, sig)`         | BLS check of a 96-hex-char signature for exactly `round`. False, never throws, on bad input.                                                  |
| `decryptWithSignature(chain, ct, sig)`    | Opens `ct` with a signature already checked by `verifyBeacon`. Throws on any failure.                                                         |
| `classify(i)`                             | `{ valid, optionIndex, nonce }` or `{ valid: false, voidReason }`. Throws for a bad signature, a bad `roundRef` or a broken runtime.          |
| `commitment(ct)`                          | `keccak256(ct)` as `0x…`.                                                                                                                     |
| `toBase64Url`, `fromBase64Url`            | The JSON transport for ciphertexts: unpadded base64url, strict decoding.                                                                      |

## Wire format

A ciphertext is a binary (non-armored) [age v1](https://age-encryption.org/v1) file. JSON carries it as unpadded
base64url; onchain it is `bytes`; `commitment` is keccak256 of those bytes. For quicknet:

```
age-encryption.org/v1\n
-> tlock <beaconRound> <chainHash>\n
<stanza body, base64: 64 chars>\n<64 chars>\n<43 chars>\n      U (96) ‖ V (16) ‖ W (16) = 128 bytes
--- <header MAC, base64 of 32 bytes>\n
<payload: 16-byte nonce ‖ ChaCha20-Poly1305 STREAM chunk (34 + 16)>
```

The plaintext is `0x01 | roundRef (16) | optionIndex (1) | nonce (16)`, so a ciphertext's length depends only
on the number of digits in `beaconRound`, never on the pick.

**Canonical header** (`parseHeader` in `src/header.ts`): printable ASCII lines ending in LF; the exact version
line; exactly one stanza, of type `tlock`, with exactly two single-space-separated arguments: a canonical
decimal (no sign or leading zero) and 64 lowercase hex chars; a body of strict base64 (standard alphabet, no
padding, zero trailing bits) in 64-column lines ending in a shorter line; and `--- ` plus 43 chars of strict
base64. tlock-js's own reader is lenient, so every ciphertext passes this parser before it reaches tlock-js.

**VOID order** (`classify`, first failure wins):

1. `non_canonical_header`: the header fails the rules above (including garbage, armor, extra stanzas, CRLF).
2. `wrong_target`: the stanza names another round or another chain hash (the wave-2 open question: a right
   round with a different chain hash is `wrong_target`).
3. `decrypt_failed`: the stanza body is not 128 bytes, U is not a canonical compressed G2 point, the body does
   not open (IBE `rP` check), the header MAC is wrong, or the payload is short, truncated, extended or corrupt.
   noble's `fromHex` reduces each coordinate mod p, so a U with p added to a coordinate (by an author who then
   re-signs the header MAC) would decode to the same point and open; `openParsed` decodes U, re-encodes it
   compressed and requires the same 96 bytes, and also rejects the point at infinity. tlock-js seals an empty
   plaintext as a nonce with no STREAM chunk, which is not valid age; it lands here.
4. `bad_plaintext`: not 34 bytes, version ≠ 0x01, or a round reference other than the round's.
5. `bad_option`: `optionIndex` ∉ {0, 1}.

`classify` first checks the signature with `verifyBeacon` (cached per chain, round and signature, so a round's
thousands of entries cost one pairing check) and throws if it fails: a bad signature must never produce VOIDs.

A broken runtime must not produce VOIDs either, since it would fail every entry alike. The first `classify` call
in an isolate runs `selfTest` (`src/seal.ts`): it opens one committed quicknet pick, embedded as constants, with
its recorded signature and checks the plaintext. If that fails, this and every later call in the isolate throws.
A bad ciphertext only makes noble and tlock-js throw a plain `Error`, so a `TypeError` or `ReferenceError` from
decryption (a missing global or API) is rethrown instead of becoming `decrypt_failed`.

## Decrypting with a given signature

tlock-js's `timelockDecrypt` fetches the beacon from a drand client, refuses rounds later than the wall clock,
never checks the chain hash and logs the beacon. Settlement must open every ciphertext with the one signature it
verified, so this package does not use it. Instead (`src/seal.ts`):

- **Encrypt:** tlock-js's `encryptAge` with its `createTimelockEncrypter`, given an offline chain client whose
  `info()` returns the pinned `DrandChain` (its `get` and `latest` reject). The age string tlock-js returns is a
  binary ("latin1") string; its char codes are the ciphertext bytes.
- **Decrypt:** after `parseHeader`, tlock-js's `decryptAge` with our own stanza unwrapper, which splits the body
  into U, V and W and calls tlock-js's `decryptOnG2(signature, …)`: the beacon signature is the IBE private key
  for its round. `decryptAge` then checks the header MAC and opens the STREAM payload.
- **Verify:** `@noble/curves` (the same 1.9.1 tlock-js uses) `verifyShortSignature` with the RFC 9380 G1
  domain `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` over `sha256(uint64be(round))`, the
  `bls-unchained-g1-rfc9380` rule drand-client applies.

These are deep imports (`tlock-js/age/age-encrypt-decrypt.js`, `tlock-js/crypto/ibe.js`,
`tlock-js/drand/timelock-encrypter.js`); tlock-js has no `exports` map, and the version is pinned exactly.

## Target-round check

`checkTargetRound` runs these checks in order and reports the first failure:

| `TargetRoundError`                     | Rule                                                          | Contract             |
| -------------------------------------- | ------------------------------------------------------------- | -------------------- |
| `invalid_round`                        | `beaconRound` ≥ 1                                             | `InvalidBeaconRound` |
| `beacon_too_early` / `beacon_too_late` | `closesAt + 60 ≤ beaconTime ≤ closesAt + 600`                 | `BeaconOutOfRange`   |
| `invalid_delay`                        | `60 ≤ beaconDelay ≤ 600`                                      | not checked          |
| `not_first_round`                      | `beaconRound = firstRoundAtOrAfter(closesAt + beaconDelay)`   | not checked          |
| `beacon_in_past`                       | `beaconTime > now`                                            | not checked          |
| `wrong_daily_close`                    | daily and room rounds: 21:00 America/New_York on the game day | not checked          |

The contract-enforced checks come first, so a case the contract rejects always reports one of its errors.
Non-integer `closesAt` or `now` is a caller error (`RangeError`).

## Fixtures and vectors

- `fixtures/quicknet-beacons.json`: quicknet's `/info` and rounds 1, 9, 10, 1 000 000, 12 345 678, 32 870 000 and
  32 870 075, fetched once from `api.drand.sh` on 2026-10-07 by `scripts/fetch-beacons.ts` (each entry keeps its
  source URL). The script checks the info against `QUICKNET`. Tests never touch the network.
- `fixtures/quicknet-ciphertexts.json`: one pick per recorded round, encrypted in Node by
  `scripts/make-ciphertexts.ts`. Encryption is randomized, so it ran once; the Workers test decrypts these.
  `SELF_TEST_CASE` in `src/seal.ts` copies the round 32 870 075 pick; `test/environment.test.ts` checks the copy.
- `vectors/target-round.json`: `{ cases: [{ id, closesAt, beaconDelay, beaconRound, genesis, period, now,
gameDay, expectedOk, reason, contractError }] }`, numbers as decimal strings, sorted by `id`. Each case states
  its expected client result by hand; `contractError` comes from an independent bigint model of `createRound`.
  Cases cover quicknet plus 1-second and 30-second chains, both bounds exactly and off by one, round 0 and every
  `TargetRoundError`. Regenerate with `pnpm --filter @flocked/tlock vectors`; `test/vectors.test.ts` fails if the
  file is stale.

## Tests

`pnpm --filter @flocked/tlock test` runs two Vitest projects:

- `node`: everything in `test/*.test.ts`. `FAST_CHECK_RUNS` sets the property-test runs (default 1000; the
  classify mutation property in `test/classify.properties.test.ts` runs a quarter of that, as most runs decrypt).
- `workers`: `test/*.workers.test.ts` inside workerd through `@cloudflare/vitest-plugin`. Vite pre-bundles the
  CommonJS tlock-js modules (workerd's CJS fallback cannot resolve their nested requires). `nodejs_compat` is
  only needed to _encrypt_ in a Worker: tlock-js draws its file key from `require("crypto")` when there is no
  `window`. Decryption and verification need neither.

Timing (Apple Silicon, N = 20): workerd 6.4 ms per decrypt and 5.5 ms per `verifyBeacon`; Node 22 18.4 ms and
14.9 ms. `classify` with a cached signature costs one decrypt.

## Browser bundles

tlock-js reaches `require("crypto")` through a variable; Vite 8's rolldown resolves it and fails unless
`crypto` is external (browsers take the `window.crypto` branch at runtime). This package imports the ESM build
of `@noble/curves` while tlock-js requires the CommonJS one, so a bundle can carry both.
