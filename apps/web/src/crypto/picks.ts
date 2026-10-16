// The device's copy of each Free pick (spec "Sealed picks" › Client requirements): the decoded
// plaintext (round, optionIndex, nonce) and the receipt, so Sealed can show "your pick" before the
// reveal and Verify can check the entry later. A receipt that failed any check is stored with the
// failed fields and the server's answer as received, as evidence. Keyed by user and round, so another
// account on the same browser never sees it.
import { FreeReceiptWireSchema, OptionIndexSchema, UlidSchema } from '@flocked/shared';
import { z } from 'zod';
import { readLocal, writeLocal } from '../lib/storage';

export const StoredPickSchema = z.object({
  v: z.literal(1),
  userId: UlidSchema,
  roundId: UlidSchema,
  mode: z.literal('free'),
  optionIndex: OptionIndexSchema,
  /** The plaintext's 16-byte nonce, hex. */
  nonce: z.string().regex(/^0x[0-9a-f]{32}$/),
  /** Points, decimal. */
  stake: z.string(),
  entryId: UlidSchema,
  /** The binary ciphertext, base64url, exactly as sent. */
  ciphertext: z.string(),
  receipt: FreeReceiptWireSchema,
  /** The receipt checks that failed (field names); empty when the receipt verified. */
  mismatches: z.array(z.string()),
  /** The server's answer as received, kept when anything mismatched. */
  evidence: z.unknown().optional(),
  savedAt: z.number(),
});
export type StoredPick = z.infer<typeof StoredPickSchema>;

export function pickKey(userId: string, roundId: string): string {
  return `flocked.pick.${userId}.${roundId}.free`;
}

/** The stored pick, or null when this device has none (or it doesn't parse). */
export function readPick(userId: string, roundId: string): StoredPick | null {
  const raw = readLocal(pickKey(userId, roundId));
  if (!raw) return null;
  try {
    const parsed = StoredPickSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writePick(pick: StoredPick): void {
  writeLocal(pickKey(pick.userId, pick.roundId), JSON.stringify(pick));
}
