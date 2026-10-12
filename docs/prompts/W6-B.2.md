# Session W6-B.2: finish the ticket signer session

**Role:** build. **Size:** S. Continue on branch `w6-b-signer` in `../flocked-w6-b` (`git pull`).

Read `docs/sessions/W6-B.md` (status `partial`) and the original prompt `docs/prompts/W6-B.md`.

Tasks:
1. `pnpm check` and `pnpm format:check` (Node 22, Foundry on PATH); fix anything red.
2. Write `e2e/tests/stakes-ticket.test.ts`: operator (`OPERATOR_KEY` from the stack's `.dev.vars`) calls `createRound` on the escrow; a fresh player gets MockUSDC (`mint`) and approves; sign the ticket through `apps/signer/src/sign.ts` (`signTicket`, `escrowTarget`, `signerKey`) with an in-memory `TicketStore` and the key from `e2e/stack/.run/ticket-signer.dev.vars`; assert `escrow.ticketDigest(ticket)` equals the hash, `enter` succeeds and `Entered` carries it; a ticket signed by another key reverts; the API's `.dev.vars` has no `TICKET_SIGNER_KEY`. Run it on `pnpm stack:up`.
3. Update the W6-B handoff to `complete`, commit (files by name), push, and end with: "When W6-A, B and C all report complete, start W6-D from `docs/prompts/W6-D.md`."
