// The device's copy of a Stakes pick. A Stakes entry's ciphertext is onchain, not in a receipt, so
// there is nothing to verify against a signer here (spec "Client app" › Verify: "Stakes entries
// verify from any device through the `Entered` event"). What the device keeps is the plaintext it
// encrypted — the option and the nonce — so Sealed can show the pick before the reveal and the
// Verify page can open the player's own entry later, plus the wallet that entered and the
// transaction that carried it.
//
// Kept beside the Free pick (`crypto/picks.ts`) under its own key, so a player who entered both
// modes in one round has both.
import { AddressSchema, Hex32Schema, OptionIndexSchema, UlidSchema } from '@flocked/shared';
import { z } from 'zod';
import { readLocal, writeLocal } from '../../lib/storage';

export const StoredStakesPickSchema = z.object({
  v: z.literal(1),
  userId: UlidSchema,
  roundId: UlidSchema,
  mode: z.literal('stakes'),
  optionIndex: OptionIndexSchema,
  /** The plaintext's 16-byte nonce, hex. */
  nonce: z.string().regex(/^0x[0-9a-f]{32}$/),
  /** USDC base units, decimal: the round's fixed stake. */
  stake: z.string(),
  /** The binary ciphertext, base64url, exactly as it went onchain. */
  ciphertext: z.string(),
  /** The wallet that called `enter`, and so the one the payout belongs to. */
  wallet: AddressSchema,
  /** The transactions the user operation produced, newest batch first. */
  txHashes: z.array(Hex32Schema),
  savedAt: z.number(),
});
export type StoredStakesPick = z.infer<typeof StoredStakesPickSchema>;

export function stakesPickKey(userId: string, roundId: string): string {
  return `flocked.pick.${userId}.${roundId}.stakes`;
}

/** The stored pick, or null when this device has none (or it doesn't parse). */
export function readStakesPick(userId: string, roundId: string): StoredStakesPick | null {
  const raw = readLocal(stakesPickKey(userId, roundId));
  if (!raw) return null;
  try {
    const parsed = StoredStakesPickSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeStakesPick(pick: StoredStakesPick): void {
  writeLocal(stakesPickKey(pick.userId, pick.roundId), JSON.stringify(pick));
}
