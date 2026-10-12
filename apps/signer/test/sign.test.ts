// The signer boundary (wave-6 pinned interface; spec "Identity and personhood" › Entry tickets
// (Stakes)): `signTicket` through the Worker's own entrypoint signs only a ticket apps/api has
// recorded in stakes_tickets, under this deployment's escrow domain, while the kill switch is on and
// the ticket is live. Nothing signs over HTTP, nothing is written, and no person tag is logged.
import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { recoverAddress, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignTicketRequest } from '../src/types.js';
import {
  record,
  setStakesEnabled,
  stakesRound,
  ticketFor,
  useSignerKey,
  type ESCROW,
} from './helpers.js';

const signer = exports.default;

/** The rejection message of a refused call. */
async function refusal(req: SignTicketRequest): Promise<string> {
  try {
    await signer.signTicket(req);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the signer to refuse');
}

let signerAddress: string;
beforeEach(async () => {
  signerAddress = useSignerKey();
  await setStakesEnabled(true);
});

describe('signTicket', () => {
  it('signs a recorded ticket: the signature recovers to the ticket signer over the digest', async () => {
    const round = await stakesRound();
    const t = ticketFor(round);
    await record(round.roundId, t);
    const { signature } = await signer.signTicket(t);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await recoverAddress({ hash: t.ticketHash, signature })).toBe(signerAddress);
  });

  it('refuses to sign a hash with no stakes_tickets row', async () => {
    const round = await stakesRound();
    const t = ticketFor(round);
    expect(await refusal(t)).toContain('ticket_refused: no_row');
    // The same ticket once recorded is signed: the row is what was missing.
    await record(round.roundId, t);
    await expect(signer.signTicket(t)).resolves.toHaveProperty('signature');
  });

  it('refuses a ticketHash that is not the digest of the fields, even when that hash has a row', async () => {
    const round = await stakesRound();
    const t = ticketFor(round);
    await record(round.roundId, t);
    // Another wallet presenting the recorded hash.
    const other = ticketFor(round, { personTag: t.personTag, expiry: t.expiry });
    expect(await refusal({ ...other, ticketHash: t.ticketHash })).toContain('hash_mismatch');
  });

  it('refuses when the recorded row disagrees with the ticket (wallet, tag, expiry, round)', async () => {
    const round = await stakesRound();
    const a = ticketFor(round);
    await record(round.roundId, a, { wallet: '0x000000000000000000000000000000000000beef' });
    expect(await refusal(a)).toContain('row_mismatch');

    const b = ticketFor(round);
    await record(round.roundId, b, { person_tag: `0x${'11'.repeat(32)}` });
    expect(await refusal(b)).toContain('row_mismatch');

    const c = ticketFor(round);
    await record(round.roundId, c, { expiry: c.expiry + 1 });
    expect(await refusal(c)).toContain('row_mismatch');

    // A row filed under another round than the one the ticket names.
    const otherRound = await stakesRound();
    const d = ticketFor(round);
    await record(otherRound.roundId, d);
    expect(await refusal(d)).toContain('row_mismatch');
  });

  it('refuses an expired ticket', async () => {
    const round = await stakesRound();
    const t = ticketFor(round, {}, -1);
    await record(round.roundId, t);
    expect(await refusal(t)).toContain('expired');
  });

  it('refuses while the kill switch is off or unset', async () => {
    const round = await stakesRound();
    const t = ticketFor(round);
    await record(round.roundId, t);
    await setStakesEnabled(false);
    expect(await refusal(t)).toContain('stakes_disabled');
    await setStakesEnabled(null);
    expect(await refusal(t)).toContain('stakes_disabled');
  });

  it('refuses a malformed request and a missing key', async () => {
    const round = await stakesRound();
    const t = ticketFor(round);
    await record(round.roundId, t);
    expect(await refusal({ ...t, wallet: t.wallet.toUpperCase() as Hex })).toContain('bad_request');
    expect(await refusal({ ...t, expiry: 1.5 })).toContain('bad_request');
    Object.assign(env, { TICKET_SIGNER_KEY: undefined });
    expect(await refusal(t)).toContain('not_configured');
  });

  it('signs under the deployment escrow domain only (another escrow gives another digest)', async () => {
    const round = await stakesRound();
    const t = ticketFor(round);
    await record(round.roundId, t);
    const other: typeof ESCROW = '0x00000000000000000000000000000000000e5c41';
    Object.assign(env, {
      LOCAL_DEPLOYMENT: JSON.stringify({
        escrow: other,
        anchor: '0xf10cced000000000000000000000000000000001',
        usdc: '0x0000000000000000000000000000000000005dc0',
        deployBlock: 0,
      }),
    });
    expect(await refusal(t)).toContain('hash_mismatch');
  });
});

describe('the boundary', () => {
  it('answers 404 to every HTTP request: nothing signs over fetch', async () => {
    const round = await stakesRound();
    const t = ticketFor(round);
    await record(round.roundId, t);
    for (const [method, path] of [
      ['GET', '/'],
      ['POST', '/'],
      ['POST', '/signTicket'],
      ['POST', '/sign'],
    ] as const) {
      const res = await signer.fetch(
        new Request(`https://signer.flocked.test${path}`, {
          method,
          ...(method === 'POST' ? { body: JSON.stringify(t) } : {}),
        }),
      );
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.text()).not.toMatch(/0x[0-9a-f]{130}/);
    }
  });

  it('writes nothing to D1 when it signs or refuses', async () => {
    const round = await stakesRound();
    const t = ticketFor(round);
    await record(round.roundId, t);
    const snapshot = async () =>
      (await env.DB.prepare('SELECT * FROM stakes_tickets ORDER BY ticket_hash').all()).results;
    const before = await snapshot();
    await signer.signTicket(t);
    await refusal(ticketFor(round));
    expect(await snapshot()).toEqual(before);
  });

  describe('logs', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a refusal logs its reason and round, never the person tag, wallet or ticket hash (NFR-8)', async () => {
      const lines: string[] = [];
      for (const level of ['log', 'info', 'warn', 'error'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(' '));
        });
      }
      const round = await stakesRound();
      const t = ticketFor(round);
      await refusal(t);
      await record(round.roundId, t);
      await signer.signTicket(t);
      const text = lines.join('\n');
      expect(text).toContain('ticket_refused');
      for (const secret of [t.personTag, t.wallet, t.ticketHash]) {
        expect(text.toLowerCase()).not.toContain(secret.slice(2));
      }
    });
  });
});
