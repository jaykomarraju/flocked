// Signer test fixtures: a throwaway signer key and local deployment, a Stakes round with an escrow
// round ID, the kill switch, and tickets recorded the way apps/api records them (the row's hash is
// the ticket's EIP-712 digest under the deployment's escrow domain).
import { env } from 'cloudflare:test';
import { ticketDigest, type Eip712Target } from '@flocked/shared';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SignTicketRequest } from '../src/types.js';

export const ESCROW: Address = '0x00000000000000000000000000000000000e5c40';
export const TARGET: Eip712Target = { chainId: 31337, verifyingContract: ESCROW };

/** A fresh signer key in `env` (and the local deployment); returns its address. */
export function useSignerKey(): Address {
  const key = generatePrivateKey();
  Object.assign(env, {
    TICKET_SIGNER_KEY: key,
    LOCAL_DEPLOYMENT: JSON.stringify({
      escrow: ESCROW,
      anchor: '0xf10cced000000000000000000000000000000001',
      usdc: '0x0000000000000000000000000000000000005dc0',
      deployBlock: 0,
    }),
  });
  return privateKeyToAccount(key).address;
}

export async function setStakesEnabled(enabled: boolean | null): Promise<void> {
  await env.DB.prepare("DELETE FROM config WHERE key = 'mode.stakes.enabled'").run();
  if (enabled !== null) {
    await env.DB.prepare(
      "INSERT INTO config (key, value_json, updated_at) VALUES ('mode.stakes.enabled', ?1, 0)",
    )
      .bind(JSON.stringify(enabled))
      .run();
  }
}

let seq = 0;

/** A locked round with a Stakes mode whose escrow round ID is returned. */
export async function stakesRound(): Promise<{ roundId: string; chainRoundId: string }> {
  const n = ++seq;
  const roundId = `01K7S1GNER00000000000000${String(n).padStart(2, '0')}`;
  const chainRoundId = String(100 + n);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rounds (id, kind, opens_at, closes_at, status) VALUES (?1, 'daily', ?2, ?3, 'open')",
    ).bind(roundId, 1_700_000_000_000 + n * 1000, 1_800_000_000_000 + n * 1000),
    env.DB.prepare(
      "INSERT INTO round_modes (round_id, mode, status, chain_round_id) VALUES (?1, 'stakes', 'pending', ?2)",
    ).bind(roundId, chainRoundId),
  ]);
  return { roundId, chainRoundId };
}

export function randomHex32(): Hex {
  return generatePrivateKey();
}

/** A ticket request for `round`, expiring `ttlSec` from now. */
export function ticketFor(
  round: { chainRoundId: string },
  over: Partial<Omit<SignTicketRequest, 'ticketHash'>> = {},
  ttlSec = 300,
): SignTicketRequest {
  const fields = {
    roundId: round.chainRoundId,
    wallet: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address,
    personTag: randomHex32(),
    expiry: Math.floor(Date.now() / 1000) + ttlSec,
    ...over,
  };
  const ticketHash = ticketDigest(TARGET, {
    roundId: BigInt(fields.roundId),
    wallet: fields.wallet,
    personTag: fields.personTag,
    expiry: BigInt(fields.expiry),
  }).toLowerCase() as Hex;
  return { ...fields, ticketHash };
}

/** Records `t` in stakes_tickets as apps/api does before calling the signer (`over` overrides columns). */
export async function record(
  roundId: string,
  t: SignTicketRequest,
  over: Partial<{ wallet: string; person_tag: string; expiry: number }> = {},
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO stakes_tickets (ticket_hash, round_id, person_tag, user_id, wallet, expiry, issued_at) ' +
      "VALUES (?1, ?2, ?3, 'U', ?4, ?5, ?6)",
  )
    .bind(
      t.ticketHash,
      roundId,
      over.person_tag ?? t.personTag,
      over.wallet ?? t.wallet,
      over.expiry ?? t.expiry,
      Date.now(),
    )
    .run();
}
