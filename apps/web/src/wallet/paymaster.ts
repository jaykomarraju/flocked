// The sponsored user operation (spec "Smart contract" › Gas and UX): entering, claiming, refund
// claims and `finalize` cost the player no ETH, because the wallet sends them through the app's
// ERC-7677 paymaster proxy (`POST /api/v1/paymaster`, wave-10 "Pinned interfaces", W10-D), which
// decides what it will sponsor. The proxy's allow list is the rule; the client only asks.
//
// Nothing here falls back to an unsponsored transaction: the paymaster refusing is an error the
// player sees, not something to pay around silently.
import { API_BASE_PATH } from '@flocked/shared';

/** The paymaster proxy, absolute because the wallet fetches it from its own context. */
export function paymasterUrl(origin: string = window.location.origin): string {
  return new URL(`${API_BASE_PATH}/paymaster`, origin).toString();
}

/** The EIP-5792 capability that points a `wallet_sendCalls` batch at the proxy. */
export function paymasterCapability(origin?: string): {
  paymasterService: { url: string };
} {
  return { paymasterService: { url: paymasterUrl(origin) } };
}
