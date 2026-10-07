# Session W2-A: `@flocked/tlock`

**Role:** build. **Size:** M. **Model:** Opus 5.5.

## Read first
- `plan.md` sections 2 (Protocol), 3.2 (Handoff template) and 4 (Global conventions). Read nothing else in `plan.md`.
- `docs/plan/wave-2.md`: the intro, "Pinned interfaces" P2.1, and section "W2-A".
- `docs/sessions/W1-Z.md` (wave-1 summary).
- Spec sections, loaded with `pnpm spec "<heading>"`: "Sealed picks (timelock encryption)" (all); "Round lifecycle" with `--sub "Scheduling"`. Neither changed in wave 1.
- `packages/settle/src/types.ts`: the `VoidReason` type and `VOID_REASONS` that `classify` returns.

## Objective
Build `@flocked/tlock` per P2.1 on `tlock-js`: pinned quicknet config with an env override, beacon math and target-round checks, the 34-byte plaintext codec, binary-age encryption, canonical-header checks, BLS beacon verification, decryption with a given signature, and VOID classification. Prove it in Node and in the Workers runtime, using recorded quicknet beacons, and produce the target-round vectors that W2-D replays through the contract.

## Starting point
- Base: tag `wave-1`. Branch: `w2-a-tlock`. Worktree: `../flocked-w2-a`.
  ```bash
  git fetch origin --tags
  git worktree add ../flocked-w2-a -b w2-a-tlock wave-1
  cd ../flocked-w2-a && pnpm install --frozen-lockfile && (cd contracts && forge soldeer install)
  ```

## Scope and file ownership
- May create or edit: `packages/tlock/**`, `docs/sessions/W2-A.md`. `pnpm-lock.yaml` only as `pnpm add`/`pnpm install` changes it for `packages/tlock`'s own dependencies (D regenerates it if A's and B's changes conflict).
- Must not touch: other packages, `contracts/`, root `package.json`, `pnpm-workspace.yaml`, `eslint.config.js`, `.github/workflows/*` (ask D under "Notes for D and Z"), `Product_Spec.md`, `Design_Language.md`, `plan.md`, `docs/plan/`.

## Pinned interfaces
- P2.1 in `docs/plan/wave-2.md`: every export and signature; the wire format (binary age, base64url in JSON, `commitment` = keccak256 of the bytes); `classify` never throws for bad input but throws when `verifyBeacon` fails; fixture and vector paths and formats.
- `VoidReason` comes from `@flocked/settle` (a `workspace:*` dependency). Don't redefine it.
- Package conventions as in `packages/settle`: `"type": "module"`, `exports` pointing at `src/index.ts`, `tsconfig.json` extending `../../tsconfig.base.json`, and scripts `typecheck`, `lint` and `test`, so the root `pnpm check` picks the package up.

## Tasks
1. Create the worktree (above).
2. Scaffold `packages/tlock`. Add `tlock-js` (latest stable; record the version) and the test dependencies (`fast-check`, `@cloudflare/vitest-pool-workers`).
3. Implement P2.1: `src/chains.ts` (`QUICKNET`, `chainFromEnv`; the only place chain constants live), beacon math (`beaconTime`, `firstRoundAtOrAfter`, `checkTargetRound`, which mirrors `createRound`'s beacon rule), the plaintext codec, `roundRefFrom*`, `encryptPick`, `isCanonicalHeader`, `verifyBeacon`, `decryptWithSignature`, `classify`, `commitment`.
4. `fixtures/quicknet-beacons.json`: at least 5 real quicknet rounds, fetched once from `api.drand.sh` and committed with their source URLs. Tests never touch the network.
5. `vectors/target-round.json` in the P2.1 format (decimal strings), made by a script and checked for freshness by a test. Cover both delay bounds, exact-bound and off-by-one cases, beacon round 0 (the contract rejects it), and every `TargetRoundError`.
6. Tests for rows TL-1 (Workers half), TL-2, TL-3 and TL-4 (TypeScript half) in `docs/plan/traceability.md`:
   - an encrypt/decrypt round trip in Node;
   - a Workers-runtime Vitest project proving decrypt and `verifyBeacon` work there;
   - a flipped signature bit fails `verifyBeacon` and makes `classify` throw;
   - each malformed-ciphertext and bad-plaintext case returns its exact VOID reason;
   - a fast-check property that the plaintext codec round-trips and always gives 34 bytes.

   Report the ms per decrypt in the Workers runtime (an input to the load test).
7. `packages/tlock/README.md`: the API, the wire format, how the fixtures and vectors were made, and how decrypt-with-given-signature works.

## Tests and checks
- `pnpm --filter @flocked/tlock typecheck`, `lint` and `test`, plus the root `pnpm check`, all pass.
- No test is skipped, deleted or weakened without a line in the handoff's Deviations with the reason.

## Definition of done
- P2.1 is implemented. TL-2, TL-3, TL-1 (Workers half) and TL-4 (vectors) each have a named, passing test listed in the handoff. Fixtures and vectors are committed. The handoff is written.

## Constraints
- Wave-file open question: a stanza that targets the right round but a different chain hash is `wrong_target`. Note it in the handoff.
- If `tlock-js` doesn't expose decrypt-with-given-signature, wrap its internals or use its beacon-free path, and document the approach.
- Never commit secrets. Don't edit the spec; record spec problems in the handoff. Don't fake owner actions.
- Stage files by name. Commits end with the attribution line from your system reminder. Stay within size M; if running low, stop at a green commit, write the handoff as `partial` and emit `W2-A.2` (plan.md 2.6).

## End of session
1. Commit, then `git push -u origin w2-a-tlock`.
2. Write `docs/sessions/W2-A.md` from plan.md 3.2. Under "Notes for D and Z", list any root script or CI change you need, the Workers-test setup and the decrypt timing. Commit and push.
3. End with your status and: "When W2-A, B and C all report complete, start W2-D from `docs/prompts/W2-D.md`."
