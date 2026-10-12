// The ticket signer Worker (spec "Architecture"; wave-6 pinned interface). Its default export is a
// WorkerEntrypoint whose one RPC method, `signTicket`, apps/api reaches through the service binding
// `SIGNER`. It has no route and no workers.dev URL, and `fetch` answers 404, so nothing signs over
// HTTP. A refusal rejects with `ticket_refused: <reason>`.
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env.js';
import { escrowTarget, signerKey, signTicket } from './sign.js';
import { d1TicketStore } from './store.js';
import { REFUSED, TicketRefused, type SignTicketRequest, type SignTicketResult } from './types.js';

export type { SignTicketRequest, SignTicketResult } from './types.js';

function logRefusal(reason: string, roundId: unknown): void {
  // The round ID only: never the person tag, wallet or ticket hash (NFR-8).
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'ticket_refused',
      reason,
      roundId: typeof roundId === 'string' ? roundId : null,
    }),
  );
}

export default class TicketSigner extends WorkerEntrypoint<Env> {
  override fetch(): Response {
    return new Response('Not found', { status: 404 });
  }

  async signTicket(req: SignTicketRequest): Promise<SignTicketResult> {
    try {
      return await signTicket(
        {
          store: d1TicketStore(this.env.DB),
          key: signerKey(this.env),
          escrow: escrowTarget(this.env),
          nowSec: Math.floor(Date.now() / 1000),
        },
        req,
      );
    } catch (err) {
      const reason = err instanceof TicketRefused ? err.reason : 'internal';
      logRefusal(reason, (req as Partial<SignTicketRequest> | undefined)?.roundId);
      if (err instanceof TicketRefused) throw err;
      throw new Error(`${REFUSED}: internal`, { cause: err });
    }
  }
}
