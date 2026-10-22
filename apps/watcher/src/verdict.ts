// The watcher's published verdict (wave-10.md "Pinned interfaces"). W10-D copies this schema into
// `packages/shared/src/watcher.ts`, so nothing here may depend on the watcher's bindings.
//
// A verdict is evidence: it is signed once, stored write-once and served byte for byte at
// `GET /verdicts/:subject/:id`. Its three values follow `@flocked/verify`'s exit codes (W9-B):
// 0 match, 1 mismatch, 2 unable (the library calls it `unverifiable`).
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage, type Address, type Hex } from 'viem';
import { z } from 'zod';

/**
 * What a verdict is about. Each (subject, roundId) pair has at most one verdict, so the subject
 * carries the mode: W11-B adds `free_anchor` and `free_settlement` beside these.
 * - `stakes_round`: `RoundCreated` against the config published at lock and the rules that do not
 *   depend on the backend;
 * - `stakes_proposal`: the `OutcomeProposed` log, by full recompute through `@flocked/verify`;
 * - `stakes_refund`: a void, `refundTooFew` or a timeout that reached Refunded without a proposal.
 */
export const VERDICT_SUBJECTS = ['stakes_round', 'stakes_proposal', 'stakes_refund'] as const;
export type VerdictSubject = (typeof VERDICT_SUBJECTS)[number];

export const VERDICT_VALUES = ['match', 'mismatch', 'unable'] as const;
export type VerdictValue = (typeof VERDICT_VALUES)[number];

/** A verdict pages the guardian unless it is a match. */
export const pages = (v: VerdictValue): boolean => v !== 'match';

export const UnsignedVerdictSchema = z.strictObject({
  subject: z.enum(VERDICT_SUBJECTS),
  /** The round's ULID. */
  roundId: z.string().min(1),
  mode: z.enum(['free', 'stakes']),
  verdict: z.enum(VERDICT_VALUES),
  /** Every check that decided the verdict, in the order they ran. */
  reasons: z.array(z.string()),
  /** Epoch ms when the checks ran. */
  checkedAt: z.number().int().nonnegative(),
});
export type UnsignedVerdict = z.infer<typeof UnsignedVerdictSchema>;

export const VerdictSchema = UnsignedVerdictSchema.extend({
  /** EIP-191 (`personal_sign`) over `verdictMessage`, by WATCHER_KEY. */
  signature: z.string().regex(/^0x[0-9a-f]+$/),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * The exact string the signature covers: JSON with the fields in this fixed order, so signer and
 * verifier agree without a canonical-JSON implementation on either side. The prefix names the
 * format, so a future field cannot be confused with this one.
 */
export function verdictMessage(v: UnsignedVerdict): string {
  return `flocked-watcher-verdict/1\n${JSON.stringify({
    subject: v.subject,
    roundId: v.roundId,
    mode: v.mode,
    verdict: v.verdict,
    reasons: v.reasons,
    checkedAt: v.checkedAt,
  })}`;
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** `WATCHER_KEY` as a viem private key. Throws when it is missing or malformed (a deploy error). */
export function watcherKey(raw: string | undefined): Hex {
  const key = raw?.startsWith('0x') ? raw : raw ? `0x${raw}` : '';
  if (!KEY_RE.test(key)) throw new Error('WATCHER_KEY must be 32 bytes of hex');
  return key.toLowerCase() as Hex;
}

/** The address verdicts are signed by, for the handoff and for consumers of the verdict route. */
export function watcherAddress(key: Hex): Address {
  return privateKeyToAccount(key).address;
}

export async function signVerdict(key: Hex, v: UnsignedVerdict): Promise<Verdict> {
  const signature = await privateKeyToAccount(key).signMessage({ message: verdictMessage(v) });
  return { ...v, signature };
}

/** True when `v.signature` is `address`'s EIP-191 signature over `verdictMessage(v)`. */
export function verifyVerdict(v: Verdict, address: Address): Promise<boolean> {
  const { signature, ...unsigned } = v;
  return verifyMessage({ address, message: verdictMessage(unsigned), signature: signature as Hex });
}
