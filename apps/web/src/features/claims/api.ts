// What the Claims screen calls beyond `api` (src/api/client.ts), and its query keys.
//
// `GET /claims` answers the signed-in caller (and every account merged into them) with no query, or
// any wallet with `?wallet=0x…`, served from public bundle data so a wallet with no account can
// still claim. `AddressSchema` is lowercase-only (W6-Z carry-over), so the address is lowercased
// before it goes on the query string.
import { ClaimsResponseSchema } from '@flocked/shared';
import { endpoint } from '../../api/client';

export const claims = endpoint('GET', '/claims', null, ClaimsResponseSchema);

/** The claims of the signed-in caller, or of one wallet. */
export const claimsKey = (wallet: string | null) => ['claims', wallet ?? 'me'] as const;

/** The address as `GET /claims` takes it: lowercase, because `AddressSchema` accepts nothing else. */
export function walletQuery(wallet: string): string {
  return wallet.toLowerCase();
}
