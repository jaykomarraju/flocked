# W7-B handoff: Identities, merges, deletion, limits

## Status
complete — every Identity endpoint answers per its schema, the W3-Z, W5-Z and W6-Z carry-over items are closed with tests, and `pnpm check` and `pnpm format:check` are green.

## Summary
- `src/identity/`: linking with proof (SIWE, Farcaster, email code; Coinbase stays W5-B's flow), Farcaster-verified wallets offered as unverified rows (refreshed daily, dismissals remembered), unlink limits, pending merges and their confirmation, account deletion.
- Merge confirmation is one D1 batch whose `abortIf` guards re-check every refusal inside the transaction. The kept account takes the person ID, the lower cap and pending raise, identities, per-scope balances through paired `merge` rows, rooms and ownership, and the losing account's game-day Stakes tickets.
- Deletion anonymizes the account and the accounts merged into it, writes the tombstone with the cap state and the account ID, expires merges, queues card re-renders and writes an audit row.
- `src/limits/`: the cap rules (decrease now, raise after 24 h) and self-exclusion (lengthen only; a permanent one lifts on request 6 months in, effective 7 days later). Audit rows for limits, merges and deletion.
- Per person: carrying `stakes_tickets.user_id` at a merge and at re-verification after deletion keeps the daily cap and one-live-ticket rule per person without touching `stakes/cap.ts`.
- W3-Z: reserved handles, no email enumeration, email codes in AuthDO, AuthDO KV errors → `unavailable`, the `users` 0001/0002 migration test, unverified rows never block, suspended accounts read-only. `POST /me/tos` takes `ageAttested: 18 | 21`.

## Branch and head commit
`w7-b-identity` @ `9368cc3` (code; the handoff commit follows it)

## Files touched
- New: `apps/api/src/identity/{accounts,proof,link,merge,delete,offers,sql}.ts`, `apps/api/src/limits/{index,rules}.ts`, `apps/api/migrations/0015_identity.sql`, `packages/shared/src/reserved-handles.ts` (+ test), `apps/api/test/identity/{fixtures,link,unlink,merge,delete,cap}.test.ts`, `apps/api/test/limits/limits.test.ts`, `apps/api/test/me/writes.test.ts`.
- Edited: `apps/api/src/routes/{me,limits}.ts`, `routes/auth.ts` (email start/verify only), `src/auth/{email,profile,siwe}.ts`, `src/do/auth-do.ts`, `src/personhood/verify.ts`; `packages/shared/src/{api/me,index}.ts`, `test/fixtures/api/me.json`; tests `test/auth/{auth-do,email,rate-limit}.test.ts`, `test/me/me.test.ts`, `test/migrations.test.ts`, `test/routes.test.ts`, `test/stakes/prepare.test.ts` (see Deviations).

## Tests run
| Command | Result |
| --- | --- |
| `pnpm check` (Node 22.23.1) | pass: node:test 20, abi 13, settle 66, tlock 176, shared 461, signer 18, api 892, forge 202 |
| `pnpm format:check` | pass |
| ticket carry neutered (`AND 0` in `carryTicketsStatement`) | both `test/identity/cap.test.ts` tests fail; restored |

## Traceability rows covered
- **ID-1:** `apps/api/test/identity/link.test.ts` (linking with proof, pending merges, unverified rows, offers, email), `unlink.test.ts`, `merge.test.ts` ("the transfer", "who may confirm", "refusals", "a pending merge from the personhood callback", `mergedCapState`), `delete.test.ts`, `cap.test.ts`.
- **E2E-9 (API half):** `apps/api/test/limits/limits.test.ts` › "E2E-9 (API): self-exclusion" (timed can't shorten; permanent lifts 7 days after a request 6 months in). The UI half stays W12-D.
- Required extras: deletion anonymizes and keeps ledger rows (`delete.test.ts` first test); atomic merge with paired rows (`merge.test.ts` "moves everything…", "is atomic…"); `ageAttested` below the required age (`test/me/writes.test.ts`); the cap per person (`cap.test.ts`). ID-4 grows two enumeration tests (`test/auth/email.test.ts`).

## Deviations
- `test/stakes/prepare.test.ts` is W6-F1's: two `ageAttested: true` became `21` and `18`. The pinned schema change breaks the old literal; nothing else changed. D may see a trivial conflict.
- `test/routes.test.ts` (not in my list): my nine rows join `IMPLEMENTED`, as the file asks owners to do.
- `test/auth/email.test.ts`, `auth-do.test.ts`: codes are written through AuthDO instead of KV. "Unknown address: no code stored" became "a code is stored and nothing is sent" (the W3-Z fix). A used code now reads `used`, not `unknown`; both give the same message. `test/me/me.test.ts`: the `/me/email` 501 test became a referrals test.
- Suspended accounts may still lower their cap, self-exclude and edit notification prefs. Responsible-play protections and private settings stay available. Raising the cap, lifting an exclusion and every other write refuse `account_suspended`. Z: confirm with the owner.
- Deletion is also refused while a Stakes ticket is live, because an entry may still land. The `merges` rate-limit bucket isn't taken: the D1 rule enforces 30 days, and a bucket would block a retry after a refused confirm.
- The pin names `routes/identity.ts`; the prompt says `routes/me.ts`; I followed the prompt.
- The session ran past size M; it ended complete, so no `.2`.

## Spec issues
1. "Data model": email codes now live in AuthDO storage, not KV (W3-Z decision); nonces stay in KV. Update the sentence.
2. "Data model" `person_tombstones`: new `user_id` (0015) lets re-verification carry the deleted account's tickets for today and later game days. Add the column.
3. "Merging accounts": either account may confirm by proving one of the other's sign-in identities, and a pair keeps one pending merge. With two pending raises, the lower amount wins with its own timer (tie: later timer). Only different person IDs set `refused`; transient refusals leave it pending. Recommend saying so.
4. "Responsible play": a timed → permanent change restarts the 6-month clock; "permanent" again during the cooling-off cancels the lift; months are calendar months. There is no maximum cap (bounded only by safe integers). Recommend confirming, and setting a maximum.
5. "Account deletion": rooms the user owns keep the anonymized owner; memberships and `ref_code` stay. Recommend a rule (e.g. hand ownership to the oldest member).
6. "Notifications": no `security_notice` kind for an unlinked identity. Recommend `identity_unlinked`.

## Open issues
- `account_suspended` on routes I don't own: entries and `/prepare` already refuse. W5-B's `POST /me/personhood` and its callback accept suspended accounts (`verify.ts`). Questions, votes, rooms and push are still stubs, so their owners (W8+) must refuse.
- Wallet offers need a Farcaster hub: `FARCASTER_HUB_URL` (unset: nothing is offered). Owner: choose a hub; Neynar's needs an API key, which would be a secret.
- Deleted accounts: the card re-render consumer and edge-cache purge (W10-A); boards, streaks and profiles exclude deleted and merged accounts (W8); the delete sheet lists unclaimed Stakes payouts with "Claim all" (UI, W12).
- Offers are refreshed on a Farcaster link and on `GET /me` (once a day). D may also call `refreshFarcasterOffers` from `/auth/farcaster`.

## Notes for D and Z
- **No `cap.ts` change is needed.** `stakedOnGameDay` and `/prepare`'s conditional insert count by `stakes_tickets.user_id`, so the carry re-points the rows (`src/identity/sql.ts` `carryTicketsStatement`, used by `merge.ts` and `personhood/verify.ts`). W6-F1's O2 change to the ticket branch composes with it.
- **Registrations:** `Env.FARCASTER_HUB_URL?: string` in `src/env.ts` (read in `identity/offers.ts` through a cast until then), and the var in `wrangler.jsonc` (unset locally). In `src/do/types.ts`, `AuthDORpc` is superseded by `AuthDOMethods` in `do/auth-do.ts` (adds `issueEmailCode`; `consumeNonce` may answer `unavailable`): delete or replace it. Migration `0015` runs after W7-A's `0014`.
- **Shared:** `packages/shared/src/index.ts` gains `export * from './reserved-handles';`. In `api/me.ts`: new `AgeAttestationSchema`, `AcceptTosRequest.ageAttested: 18 | 21`, `TosState.ageRequired` required; `me.json` updated with invalid cases.
- **Merge-notice copy (for W7-Z; `copy/notifications.ts` is frozen).** No notice implies a merge completes by itself. But `merge_pending` goes to the account holding the linked identity, which is the losing account whenever it is the newer one, so "merge another account into yours" can be wrong. Suggested push body: "A request to merge two of your Flocked accounts is waiting. Confirm it in Settings by signing in to both, or ignore it." Email body: "Someone asked to merge another Flocked account with yours. Nothing changes unless it's confirmed by signing in to both accounts. It expires in 7 days if nobody acts on it." `merge_completed` goes to the kept account, and its copy fits.
- **Risky diffs worth reading:** `src/identity/merge.ts` `transferStatements` (guard order, the person-ID move, the cap-state guards), `src/identity/delete.ts`, and the tombstone carry in `src/personhood/verify.ts` `bindStatements`.
